/**
 * Typed step conditions — a small, safe expression list (no eval, no
 * sandboxing risk). All conditions on a step must pass (AND).
 *
 * Fields are dot-paths into { ...payload, subscriber: { id, email, phone } }:
 *   { field: "plan",             op: "eq",     value: "pro" }
 *   { field: "amount",           op: "gte",    value: 1000 }
 *   { field: "subscriber.email", op: "exists" }
 */

export type ConditionOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'exists'
  | 'not_exists';

export interface StepCondition {
  field: string;
  op: ConditionOp;
  value?: unknown;
}

function getPath(ctx: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), ctx);
}

export function evaluateConditions(
  conditions: StepCondition[],
  context: Record<string, unknown>,
): boolean {
  for (const condition of conditions) {
    const actual = getPath(context, condition.field);
    const expected = condition.value;

    let pass: boolean;
    switch (condition.op) {
      case 'eq':
        pass = actual === expected || String(actual) === String(expected);
        break;
      case 'neq':
        pass = actual !== expected && String(actual) !== String(expected);
        break;
      case 'gt':
        pass = Number(actual) > Number(expected);
        break;
      case 'gte':
        pass = Number(actual) >= Number(expected);
        break;
      case 'lt':
        pass = Number(actual) < Number(expected);
        break;
      case 'lte':
        pass = Number(actual) <= Number(expected);
        break;
      case 'contains':
        pass = Array.isArray(actual)
          ? actual.some((v) => v === expected || String(v) === String(expected))
          : typeof actual === 'string' && actual.includes(String(expected));
        break;
      case 'exists':
        pass = actual !== undefined && actual !== null;
        break;
      case 'not_exists':
        pass = actual === undefined || actual === null;
        break;
      default:
        pass = false;
    }
    if (!pass) return false;
  }
  return true;
}
