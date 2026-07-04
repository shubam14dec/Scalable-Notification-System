import client from 'prom-client';
import { queueDepths } from './queues';
import { allBreakers } from '../resilience/circuit-breaker';

/**
 * Prometheus metrics. Every process (API, worker, ws) exports its own
 * registry — the standard per-replica model; Prometheus aggregates.
 *
 * The two gauges use collect() callbacks, so queue depths and breaker
 * states are sampled at scrape time instead of being pushed continuously.
 */
export const register = new client.Registry();

client.collectDefaultMetrics({ register });

export const triggersTotal = new client.Counter({
  name: 'notif_triggers_total',
  help: 'Trigger requests by outcome (direct | overflow | throttled)',
  labelNames: ['result'] as const,
  registers: [register],
});

export const deliveriesTotal = new client.Counter({
  name: 'notif_deliveries_total',
  help: 'Delivery attempts by channel, provider and outcome',
  labelNames: ['channel', 'provider', 'outcome'] as const,
  registers: [register],
});

export const deliverySeconds = new client.Histogram({
  name: 'notif_delivery_seconds',
  help: 'Time spent in the delivery processor per job',
  labelNames: ['channel'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

new client.Gauge({
  name: 'notif_queue_jobs',
  help: 'Jobs per queue per state (waiting | active | delayed | failed | prioritized)',
  labelNames: ['queue', 'state'] as const,
  registers: [register],
  async collect() {
    const depths = await queueDepths();
    for (const [queue, states] of Object.entries(depths)) {
      for (const [state, count] of Object.entries(states)) {
        this.set({ queue, state }, count ?? 0);
      }
    }
  },
});

const BREAKER_STATE_VALUE: Record<string, number> = { closed: 0, 'half-open': 1, open: 2 };

new client.Gauge({
  name: 'notif_breaker_state',
  help: 'Circuit breaker state per provider (0=closed, 1=half-open, 2=open)',
  labelNames: ['provider'] as const,
  registers: [register],
  collect() {
    for (const b of allBreakers()) {
      this.set({ provider: b.key }, BREAKER_STATE_VALUE[b.state] ?? 0);
    }
  },
});
