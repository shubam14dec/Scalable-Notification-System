import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CircuitBreaker } from '../../src/resilience/circuit-breaker';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  test('stays closed under the failure threshold, opens at it', () => {
    const breaker = new CircuitBreaker('p', 3, 30_000);
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.canRequest()).toBe(true);
    breaker.onFailure(); // third consecutive failure trips it
    expect(breaker.canRequest()).toBe(false);
  });

  test('success resets the consecutive-failure count', () => {
    const breaker = new CircuitBreaker('p', 3, 30_000);
    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.canRequest()).toBe(true); // never reached 3 in a row
  });

  test('half-opens after the cooldown and allows exactly one probe', () => {
    const breaker = new CircuitBreaker('p', 1, 30_000);
    breaker.onFailure();
    expect(breaker.canRequest()).toBe(false);

    vi.advanceTimersByTime(31_000);
    expect(breaker.canRequest()).toBe(true); // the single probe
    expect(breaker.canRequest()).toBe(false); // concurrent second request blocked
  });

  test('probe success closes the breaker fully', () => {
    const breaker = new CircuitBreaker('p', 1, 30_000);
    breaker.onFailure();
    vi.advanceTimersByTime(31_000);
    expect(breaker.canRequest()).toBe(true);
    breaker.onSuccess();
    expect(breaker.canRequest()).toBe(true);
    expect(breaker.snapshot().state).toBe('closed');
  });

  test('probe failure re-opens for another full cooldown', () => {
    const breaker = new CircuitBreaker('p', 1, 30_000);
    breaker.onFailure();
    vi.advanceTimersByTime(31_000);
    breaker.canRequest();
    breaker.onFailure(); // probe failed
    vi.advanceTimersByTime(15_000);
    expect(breaker.canRequest()).toBe(false); // still open — cooldown restarted
    vi.advanceTimersByTime(16_000);
    expect(breaker.canRequest()).toBe(true);
  });
});
