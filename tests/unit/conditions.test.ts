import { describe, expect, test } from 'vitest';
import { evaluateConditions } from '../../src/core/conditions';

const ctx = {
  plan: 'pro',
  amount: 1500,
  tags: ['vip', 'beta'],
  subscriber: { id: 'u1', email: 'u1@example.com', phone: null },
};

describe('evaluateConditions', () => {
  test('empty condition list passes', () => {
    expect(evaluateConditions([], ctx)).toBe(true);
  });

  test('eq matches exact and stringified values', () => {
    expect(evaluateConditions([{ field: 'plan', op: 'eq', value: 'pro' }], ctx)).toBe(true);
    expect(evaluateConditions([{ field: 'amount', op: 'eq', value: '1500' }], ctx)).toBe(true);
    expect(evaluateConditions([{ field: 'plan', op: 'eq', value: 'free' }], ctx)).toBe(false);
  });

  test('neq', () => {
    expect(evaluateConditions([{ field: 'plan', op: 'neq', value: 'free' }], ctx)).toBe(true);
    expect(evaluateConditions([{ field: 'plan', op: 'neq', value: 'pro' }], ctx)).toBe(false);
  });

  test('numeric comparisons', () => {
    expect(evaluateConditions([{ field: 'amount', op: 'gt', value: 1000 }], ctx)).toBe(true);
    expect(evaluateConditions([{ field: 'amount', op: 'gte', value: 1500 }], ctx)).toBe(true);
    expect(evaluateConditions([{ field: 'amount', op: 'lt', value: 1500 }], ctx)).toBe(false);
    expect(evaluateConditions([{ field: 'amount', op: 'lte', value: 1499 }], ctx)).toBe(false);
  });

  test('contains works on strings and arrays', () => {
    expect(
      evaluateConditions([{ field: 'subscriber.email', op: 'contains', value: '@example' }], ctx),
    ).toBe(true);
    expect(evaluateConditions([{ field: 'tags', op: 'contains', value: 'vip' }], ctx)).toBe(true);
    expect(evaluateConditions([{ field: 'tags', op: 'contains', value: 'admin' }], ctx)).toBe(false);
  });

  test('exists / not_exists treat null and undefined as absent', () => {
    expect(evaluateConditions([{ field: 'subscriber.email', op: 'exists' }], ctx)).toBe(true);
    expect(evaluateConditions([{ field: 'subscriber.phone', op: 'exists' }], ctx)).toBe(false);
    expect(evaluateConditions([{ field: 'missing.deep.path', op: 'not_exists' }], ctx)).toBe(true);
  });

  test('dot paths traverse nested objects', () => {
    expect(evaluateConditions([{ field: 'subscriber.id', op: 'eq', value: 'u1' }], ctx)).toBe(true);
  });

  test('all conditions must pass (AND)', () => {
    expect(
      evaluateConditions(
        [
          { field: 'plan', op: 'eq', value: 'pro' },
          { field: 'amount', op: 'gt', value: 9999 },
        ],
        ctx,
      ),
    ).toBe(false);
  });

  test('unknown operator fails closed', () => {
    expect(
      evaluateConditions([{ field: 'plan', op: 'regex' as never, value: '.*' }], ctx),
    ).toBe(false);
  });
});
