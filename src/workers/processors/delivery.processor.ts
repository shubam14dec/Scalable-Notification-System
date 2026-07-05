import { UnrecoverableError, type Job } from 'bullmq';
import { env } from '../../config/env';
import { getMessage, messageByStep, updateMessage, type MessageRow } from '../../db/repositories';
import { sendWithFailover } from '../../providers/registry';
import { PermanentError } from '../../shared/errors';
import { redis } from '../../shared/redis';
import { render } from '../../core/render';
import { renderMjmlTemplate } from '../../core/email-template';
import { getTemplateVersion } from '../../db/templates.repo';
import { logExec } from '../../core/execution-log';
import { deliveriesTotal, deliverySeconds } from '../../shared/metrics';
import { withSpan, type TraceCarrier } from '../../shared/tracing';

/**
 * Closes a digest window and renders the combined content.
 *
 * The window list is atomically RENAMEd to a per-message "closing" key, so:
 *  - events arriving after the close start a fresh window (their RPUSH sees
 *    an empty key and schedules a new digest message), and
 *  - retries of THIS job re-read the same closing key — at-least-once safe.
 */
async function renderDigest(
  message: NonNullable<Awaited<ReturnType<typeof getMessage>>>,
  digestKey: string,
): Promise<{ subject?: string; body: string } | null> {
  const digest = message.content.digest!;
  const closingKey = `${digestKey}:closing:${message.id}`;

  try {
    await redis.renamenx(digestKey, closingKey);
  } catch {
    // Source key gone: a previous attempt already renamed it, or it expired.
  }

  const raw = await redis.lrange(closingKey, 0, -1);
  if (raw.length === 0) return null;

  const items = raw.map((r) => {
    try {
      return JSON.parse(r) as Record<string, unknown>;
    } catch {
      return {};
    }
  });

  const digestVars = {
    ...digest.vars,
    digest_count: items.length,
    digest_items: items
      .map((it) => (digest.itemTemplate ? render(digest.itemTemplate, it) : JSON.stringify(it)))
      .join('\n'),
  };

  return {
    subject: digest.subjectTemplate ? render(digest.subjectTemplate, digestVars) : undefined,
    body: render(digest.bodyTemplate, digestVars),
  };
}

function siblingMatches(sibling: MessageRow, statusIn: string[]): boolean {
  for (const wanted of statusIn) {
    if (wanted === 'opened' && sibling.opened_at) return true;
    if (wanted === 'read' && sibling.read_at) return true;
    if (sibling.status === wanted) return true;
  }
  return false;
}

function describeState(sibling: MessageRow, statusIn: string[]): string {
  if (statusIn.includes('opened') && sibling.opened_at) return 'opened';
  if (statusIn.includes('read') && sibling.read_at) return 'read';
  return sibling.status;
}

/**
 * Stage 3: actually deliver one message through the provider chain.
 *
 * At-least-once semantics: if a worker dies after the provider accepted the
 * send but before the DB update, the redelivered job sees status != sent and
 * would send again — the status guard plus provider-side idempotency (where
 * supported) is what narrows the duplicate window.
 */
export async function processDelivery(
  job: Job<{ messageId: string; digestKey?: string; _trace?: TraceCarrier }>,
): Promise<void> {
  const message = await getMessage(job.data.messageId);
  if (!message) {
    throw new UnrecoverableError(`message ${job.data.messageId} not found`);
  }
  if (['sent', 'delivered', 'skipped'].includes(message.status)) {
    return; // duplicate delivery of an already-handled job
  }

  await withSpan(
    'delivery.send',
    {
      'notif.transaction_id': message.transaction_id,
      'notif.channel': message.channel,
      'notif.priority': message.priority,
      'notif.attempt': job.attemptsMade + 1,
    },
    (span) => deliver(job, message, span),
    job.data._trace,
  );
}

async function deliver(
  job: Job<{ messageId: string; digestKey?: string }>,
  message: NonNullable<Awaited<ReturnType<typeof getMessage>>>,
  span: import('@opentelemetry/api').Span,
): Promise<void> {
  // Cross-step gate, checked NOW (after this step's delay): e.g. skip the
  // reminder push when the email from step 0 was already opened.
  const gate = message.content.skipIfStep;
  if (gate && !job.data.digestKey) {
    const sibling = await messageByStep(message.event_id, message.subscriber_id, gate.stepIndex);
    if (sibling && siblingMatches(sibling, gate.statusIn)) {
      await updateMessage(message.id, {
        status: 'skipped',
        error: `step ${gate.stepIndex} already ${describeState(sibling, gate.statusIn)}`,
      });
      logExec({
        tenantId: message.tenant_id,
        transactionId: message.transaction_id,
        messageId: message.id,
        level: 'info',
        detail: `skipped by cross-step condition: step ${gate.stepIndex} is ${describeState(sibling, gate.statusIn)}`,
      });
      return;
    }
  }

  let subject = message.content.subject;
  let body = message.content.body;
  let htmlBody: string | undefined;

  // Template-based email: render the pinned MJML version now.
  if (message.content.template) {
    const tpl = message.content.template;
    const source = await getTemplateVersion(message.tenant_id, tpl.key, tpl.version);
    if (!source) {
      await updateMessage(message.id, {
        status: 'failed',
        error: `template ${tpl.key} v${tpl.version} no longer exists`,
      });
      throw new UnrecoverableError(`template ${tpl.key} v${tpl.version} missing`);
    }
    const rendered = await renderMjmlTemplate(source.mjml, tpl.vars);
    htmlBody = rendered.html;
    body = rendered.text;
  }

  if (message.content.digest && job.data.digestKey) {
    const rendered = await renderDigest(message, job.data.digestKey);
    if (!rendered) {
      await updateMessage(message.id, { status: 'skipped', error: 'digest window was empty' });
      return;
    }
    subject = rendered.subject;
    body = rendered.body;
  }

  await updateMessage(message.id, { status: 'sending', attempts: job.attemptsMade + 1 });

  const timer = deliverySeconds.startTimer({ channel: message.channel });
  try {
    const result = await sendWithFailover(message.channel, {
      messageId: message.id,
      tenantId: message.tenant_id,
      to: message.content.to,
      subject,
      body,
      htmlBody,
      // Email opens are tracked via a 1px pixel keyed by message id.
      pixelUrl:
        message.channel === 'email' ? `${env.publicUrl}/o/${message.id}.gif` : undefined,
    });

    await updateMessage(message.id, {
      status: 'sent',
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      error: null,
    });
    if (job.data.digestKey) {
      await redis.del(`${job.data.digestKey}:closing:${message.id}`).catch(() => undefined);
    }
    timer();
    deliveriesTotal.inc({ channel: message.channel, provider: result.provider, outcome: 'sent' });
    span.setAttribute('notif.provider', result.provider);
    logExec({
      tenantId: message.tenant_id,
      transactionId: message.transaction_id,
      messageId: message.id,
      level: 'info',
      detail: `sent via ${result.provider} (attempt ${job.attemptsMade + 1})`,
    });
  } catch (err) {
    timer();
    const reason = (err as Error).message;

    if (err instanceof PermanentError) {
      deliveriesTotal.inc({
        channel: message.channel,
        provider: 'none',
        outcome: 'failed_permanent',
      });
      await updateMessage(message.id, { status: 'failed', error: reason });
      logExec({
        tenantId: message.tenant_id,
        transactionId: message.transaction_id,
        messageId: message.id,
        level: 'error',
        detail: `permanent failure, not retrying: ${reason}`,
      });
      throw new UnrecoverableError(reason); // straight to DLQ, no retry burn
    }

    deliveriesTotal.inc({ channel: message.channel, provider: 'none', outcome: 'retry' });
    logExec({
      tenantId: message.tenant_id,
      transactionId: message.transaction_id,
      messageId: message.id,
      level: 'warn',
      detail: `attempt ${job.attemptsMade + 1} failed, will retry: ${reason}`,
    });
    throw err; // transient -> BullMQ retries with exponential backoff + jitter
  }
}
