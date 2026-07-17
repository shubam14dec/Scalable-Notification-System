/**
 * Shared types + pure helpers for the workflow flow editor. The canvas, the
 * timing drawer, and the full step page all read the workflow draft through
 * WorkflowProvider and speak in these shapes. Kept dependency-free so every
 * surface (and its tests) can import without pulling React.
 */

export interface Condition {
  field: string;
  op: string;
  value?: unknown;
}

export interface Digest {
  windowSeconds: number;
  itemTemplate?: string;
}

export interface SkipIfStep {
  stepIndex: number;
  statusIn: string[];
}

/** One editable custom-data pair for a rich push. Kept as ordered rows in the
 * draft (not a map) so a half-typed or blank key can exist while editing —
 * toApiSteps collapses them to the `{key: value}` object the API wants. */
export interface PushDataRow {
  key: string;
  value: string;
}

/** Rich-push extras, valid only on push steps. Draft shape; toApiSteps strips
 * empties and turns `data` into an object. */
export interface PushExtras {
  clickUrl?: string;
  imageUrl?: string;
  data?: PushDataRow[];
}

export interface Step {
  channel: string;
  subject?: string;
  body: string;
  templateKey?: string;
  delaySeconds?: number;
  digest?: Digest;
  conditions?: Condition[];
  skipIfStep?: SkipIfStep;
  push?: PushExtras;
}

export const CHANNELS = ['email', 'inapp', 'sms', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Human channel labels for node headers and the add-step menu. */
export const CHANNEL_LABEL: Record<string, string> = {
  email: 'Email',
  inapp: 'In-app',
  sms: 'SMS',
  push: 'Push',
};

export const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists', 'not_exists'];
export const GATE_STATES = ['opened', 'read', 'delivered', 'sent'];

export const NEW_STEP: Step = { channel: 'email', subject: '', body: '' };

/** Real payload conditions on a step (blank rows don't count). */
export function activeConditions(step: Step): Condition[] {
  return (step.conditions ?? []).filter((c) => c.field.trim().length > 0);
}

/**
 * A step is "conditional" — it may be skipped at run time — when it carries
 * real payload conditions or a cross-step skip gate. The canvas draws a labeled
 * bypass around conditional steps; unconditional steps get a plain connector.
 * (skipIfStep only applies to steps after the first.)
 */
export function isConditional(step: Step, index: number): boolean {
  return activeConditions(step).length > 0 || (index > 0 && Boolean(step.skipIfStep));
}

/** Short human summary of a step's gate, for the bypass label. Null = none. */
export function gateLabel(step: Step, index: number): string | null {
  const parts: string[] = [];
  if (index > 0 && step.skipIfStep) {
    const ref = step.skipIfStep.stepIndex + 1;
    const state = step.skipIfStep.statusIn[0] ?? 'opened';
    parts.push(`if step ${ref} not ${state}`);
  }
  const conds = activeConditions(step);
  if (conds.length === 1) {
    const c = conds[0];
    parts.push(
      ['exists', 'not_exists'].includes(c.op)
        ? `if ${c.field} ${c.op === 'exists' ? 'exists' : 'missing'}`
        : `if ${c.field} ${opSymbol(c.op)} ${String(c.value ?? '')}`,
    );
  } else if (conds.length > 1) {
    parts.push(`if ${conds.length} conditions`);
  }
  return parts.length ? parts.join(' · ') : null;
}

function opSymbol(op: string): string {
  const map: Record<string, string> = {
    eq: '=',
    neq: '≠',
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    contains: '⊃',
  };
  return map[op] ?? op;
}

/** A one-line content summary for a node card (subject, template, or body). */
export function stepSummary(step: Step): string {
  if (step.subject?.trim()) return step.subject.trim();
  if (step.templateKey) return `template: ${step.templateKey}`;
  const body = step.body.trim().replace(/\s+/g, ' ');
  return body.length > 0 ? body : 'No content yet';
}

/** True when a step can't send — no body and no template picked. */
export function stepInvalid(step: Step): boolean {
  return !step.body.trim() && !step.templateKey;
}

/** The wait/cadence label shown ON the connector entering a step. */
export function timingLabel(step: Step): string {
  if (step.digest?.windowSeconds) return `digest ${humanSeconds(step.digest.windowSeconds)}`;
  if (step.delaySeconds) return `wait ${humanSeconds(step.delaySeconds)}`;
  return 'immediately';
}

export function humanSeconds(s: number): string {
  if (s <= 0) return '0s';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * Reduce push extras to the API's `{clickUrl?, imageUrl?, data?}` shape:
 * blank fields are omitted entirely (no empty-string keys), data rows with a
 * blank key are dropped, and the whole object collapses to undefined when
 * nothing survives. Push extras are only ever emitted on push steps.
 */
export function cleanPush(push: PushExtras | undefined): unknown {
  if (!push) return undefined;
  const out: { clickUrl?: string; imageUrl?: string; data?: Record<string, string> } = {};
  const clickUrl = push.clickUrl?.trim();
  const imageUrl = push.imageUrl?.trim();
  if (clickUrl) out.clickUrl = clickUrl;
  if (imageUrl) out.imageUrl = imageUrl;
  const data: Record<string, string> = {};
  for (const row of push.data ?? []) {
    const key = row.key.trim();
    if (key) data[key] = row.value;
  }
  if (Object.keys(data).length > 0) out.data = data;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Strip a draft workflow to the API's expected PUT body shape. */
export function toApiSteps(steps: Step[]): unknown[] {
  return steps.map((s, si) => ({
    channel: s.channel,
    subject: s.subject?.trim() || undefined,
    body: s.body,
    delaySeconds: s.delaySeconds || undefined,
    digest: s.digest?.windowSeconds ? s.digest : undefined,
    templateKey: s.channel === 'email' ? s.templateKey : undefined,
    conditions:
      activeConditions(s).length > 0
        ? activeConditions(s).map((c) => ({
            field: c.field.trim(),
            op: c.op,
            value: ['exists', 'not_exists'].includes(c.op)
              ? undefined
              : /^-?\d+(\.\d+)?$/.test(String(c.value))
                ? Number(c.value)
                : c.value,
          }))
        : undefined,
    skipIfStep: si > 0 && s.skipIfStep ? s.skipIfStep : undefined,
    push: s.channel === 'push' ? cleanPush(s.push) : undefined,
  }));
}
