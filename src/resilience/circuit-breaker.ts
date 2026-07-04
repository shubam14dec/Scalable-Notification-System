import { logger } from '../shared/logger';

type State = 'closed' | 'open' | 'half-open';

/**
 * Simple in-process circuit breaker, one per provider.
 *
 * closed    -> requests flow; N consecutive failures trips it open
 * open      -> requests are rejected instantly for openMs (fail fast,
 *              lets the failover chain try the next provider)
 * half-open -> after openMs, exactly one probe request is let through;
 *              success closes the breaker, failure re-opens it
 */
export class CircuitBreaker {
  private state: State = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    readonly key: string,
    private readonly failureThreshold = 5,
    private readonly openMs = 30_000,
  ) {}

  canRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.openMs) {
        this.state = 'half-open';
        this.probeInFlight = false;
        logger.warn({ provider: this.key }, 'circuit breaker half-open, allowing probe');
      } else {
        return false;
      }
    }
    // half-open: allow a single probe at a time
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  onSuccess(): void {
    if (this.state !== 'closed') {
      logger.info({ provider: this.key }, 'circuit breaker closed');
    }
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  onFailure(): void {
    this.consecutiveFailures += 1;
    this.probeInFlight = false;
    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      if (this.state !== 'open') {
        logger.warn(
          { provider: this.key, failures: this.consecutiveFailures },
          'circuit breaker OPEN',
        );
      }
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  snapshot() {
    return { key: this.key, state: this.state, consecutiveFailures: this.consecutiveFailures };
  }
}

const breakers = new Map<string, CircuitBreaker>();

export function breakerFor(providerId: string): CircuitBreaker {
  let b = breakers.get(providerId);
  if (!b) {
    b = new CircuitBreaker(providerId);
    breakers.set(providerId, b);
  }
  return b;
}

export function allBreakers() {
  return [...breakers.values()].map((b) => b.snapshot());
}
