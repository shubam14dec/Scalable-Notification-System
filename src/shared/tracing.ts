import {
  context,
  propagation,
  trace,
  SpanStatusCode,
  type Attributes,
  type Span,
} from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * Distributed tracing across the whole pipeline. One trigger = ONE trace:
 *
 *   trigger.accept (api) -> workflow.fanout (worker) -> fanout.process
 *     -> delivery.send (worker, per message)
 *
 * The pieces run in different processes connected only by Redis queues, so
 * the W3C `traceparent` context is carried INSIDE the job payload (`_trace`
 * field): withSpan() extracts it on the consumer side and parents the new
 * span to the producer's, stitching the trace back together.
 *
 * Everything goes through the @opentelemetry/api no-op layer, so with
 * OTEL_ENABLED=false the cost is near zero and no exporter is loaded.
 */

let provider: NodeTracerProvider | undefined;

export function initTracing(serviceName: string): void {
  if (!env.otel.enabled) return;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${env.otel.endpoint}/v1/traces` }),
      ),
    ],
  });
  provider.register(); // also installs the async context manager + W3C propagator
  logger.info({ serviceName, endpoint: env.otel.endpoint }, 'tracing enabled');
}

export async function shutdownTracing(): Promise<void> {
  await provider?.shutdown().catch(() => undefined);
}

const tracer = () => trace.getTracer('notification-system');

export type TraceCarrier = Record<string, string>;

/** Snapshot the ACTIVE span context for embedding into a queue job payload. */
export function traceCarrier(): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/**
 * Run fn inside a span. Pass the job's `_trace` carrier to parent this span
 * to the producer that enqueued the job (cross-process trace stitching).
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  carrier?: TraceCarrier,
): Promise<T> {
  const parent = carrier ? propagation.extract(context.active(), carrier) : context.active();
  return tracer().startActiveSpan(name, { attributes }, parent, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
