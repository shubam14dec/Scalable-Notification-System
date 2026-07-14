/**
 * The full step CONTENT page — a full-cover surface over the flow canvas where
 * a step's message is authored: channel, content source (inline vs template),
 * subject, body, delay + digest, the digest item template, the full conditions
 * builder, and the cross-step skip gate. Everything the timing drawer shows is
 * repeated here (authoritatively) plus the content-only fields. Edits write the
 * live draft through updateStep(); the layout header owns Save — "Back to flow"
 * only navigates.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, Bell, Mail, MessageSquare, Plus, Smartphone, Trash2, X } from 'lucide-react';
import { Button, Field, Input, Mono } from '../../ui';
import { useWorkflow } from './WorkflowProvider';
import {
  CHANNEL_LABEL,
  GATE_STATES,
  OPS,
  stepInvalid,
  type Condition,
  type Step,
} from './types';

const CHANNEL_ICON: Record<string, typeof Mail> = {
  email: Mail,
  inapp: Bell,
  sms: MessageSquare,
  push: Smartphone,
};

const selectCls =
  'h-8 w-full rounded-md border border-bd bg-transparent px-2 text-[13px] text-t1 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong';
const textareaCls =
  'w-full rounded-md border border-bd bg-transparent px-2.5 py-2 font-mono text-[13px] text-t1 placeholder:text-t3 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong';

/** Monochrome switch — no colored controls; on = inverted track. */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 ${
        checked ? 'border-transparent bg-invert' : 'border-bd bg-elevated hover:border-bd-strong'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-3.5 w-3.5 rounded-full transition-transform duration-150 ${
          checked ? 'translate-x-[18px] bg-invert-t' : 'translate-x-[3px] bg-t3'
        }`}
      />
    </button>
  );
}

export default function StepEditorPage() {
  const { index } = useParams();
  const navigate = useNavigate();
  const { steps, templates, routeKey, isNew, updateStep, removeStep, moveStep } = useWorkflow();
  const i = Number(index);
  const step = steps[i];
  const base = isNew ? '/workflows/new' : `/workflows/${routeKey}`;

  // Gentle fade-up as the cover mounts. Reduced-motion collapses it globally.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && navigate(base);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [base, navigate]);

  useEffect(() => {
    if (!step) navigate(base, { replace: true });
  }, [step, base, navigate]);
  if (!step) return null;

  const patch = (next: Partial<Step>) => updateStep(i, { ...step, ...next });

  const setDigestWindow = (raw: string) => {
    const seconds = Math.max(0, Number(raw) || 0);
    patch({ digest: seconds > 0 ? { ...step.digest, windowSeconds: seconds } : undefined });
  };

  const conditions = step.conditions ?? [];
  const setConditions = (next: Condition[]) => patch({ conditions: next });
  const updateCond = (j: number, patchCond: Partial<Condition>) =>
    setConditions(conditions.map((c, k) => (k === j ? { ...c, ...patchCond } : c)));
  const addCondition = () => setConditions([...conditions, { field: '', op: 'eq', value: '' }]);

  const Icon = CHANNEL_ICON[step.channel] ?? Mail;
  const showContentSource = step.channel === 'email' && templates.length > 0;
  const showBody = !step.templateKey;
  const showSubject = step.channel !== 'sms';
  const subjectLabel = step.channel === 'email' ? 'Subject' : 'Title';
  const digestBodyWarn =
    Boolean(step.digest) &&
    showBody &&
    !/\{\{\s*digest_items\s*\}\}|\{\{\s*digest_count\s*\}\}/.test(step.body);
  const skipOn = i > 0 && Boolean(step.skipIfStep);

  return (
    <div
      className={`absolute inset-0 z-10 overflow-y-auto bg-app transition-opacity duration-200 ease-out ${
        shown ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {/* top bar */}
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-bd bg-app/95 px-4 py-3 backdrop-blur">
        <Button variant="ghost" onClick={() => navigate(base)}>
          <ArrowLeft className="h-4 w-4" />
          Back to flow
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-4 w-4 text-t2" aria-hidden />
          <span className="truncate text-[13px] font-medium text-t1">
            {CHANNEL_LABEL[step.channel]}
          </span>
          <Mono className="text-t3">step {i + 1}</Mono>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            aria-label="Move step up"
            disabled={i === 0}
            onClick={() => moveStep(i, -1)}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            aria-label="Move step down"
            disabled={i >= steps.length - 1}
            onClick={() => moveStep(i, 1)}
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              removeStep(i);
              navigate(base);
            }}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      {/* form */}
      <div className="mx-auto max-w-[640px] space-y-6 px-4 py-8">
        {showContentSource && (
          <Field label="Content source" hint="Author inline, or render one of your saved templates">
            <select
              aria-label="Content source"
              className={selectCls}
              value={step.templateKey ?? ''}
              onChange={(e) => patch({ templateKey: e.target.value || undefined })}
            >
              <option value="" className="bg-surface">
                Inline text
              </option>
              {templates.map((t) => (
                <option key={t} value={t} className="bg-surface">
                  {t}
                </option>
              ))}
            </select>
          </Field>
        )}

        {showSubject && (
          <Field
            label={subjectLabel}
            hint={
              step.templateKey
                ? 'Optional — overrides the template subject. Supports {{variables}}'
                : 'Supports {{variables}} from the trigger payload'
            }
          >
            <Input
              value={step.subject ?? ''}
              placeholder="You have a new update, {{name}}"
              onChange={(e) => patch({ subject: e.target.value })}
            />
          </Field>
        )}

        {showBody && (
          <div>
            <span className="mb-1.5 block text-[12px] font-medium text-t2">Body</span>
            <textarea
              rows={8}
              className={textareaCls}
              placeholder={'Hi {{name}},\n\nHere is what happened…'}
              value={step.body}
              onChange={(e) => patch({ body: e.target.value })}
            />
            {digestBodyWarn && (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-t3">
                <span
                  aria-hidden
                  className="inline-block h-[7px] w-[7px] rounded-full"
                  style={{ background: 'var(--warn)' }}
                />
                This step digests events, but the body has no{' '}
                <Mono className="text-t2">{'{{digest_items}}'}</Mono> or{' '}
                <Mono className="text-t2">{'{{digest_count}}'}</Mono>.
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Delay" hint="Seconds — 0 sends immediately">
            <Input
              type="number"
              min={0}
              className="font-mono"
              value={step.delaySeconds ?? 0}
              onChange={(e) => patch({ delaySeconds: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>
          <Field label="Digest window" hint="Seconds — 0 turns digest off">
            <Input
              type="number"
              min={0}
              className="font-mono"
              value={step.digest?.windowSeconds ?? 0}
              onChange={(e) => setDigestWindow(e.target.value)}
            />
          </Field>
        </div>

        {step.digest && (
          <Field
            label="Digest item template"
            hint="Rendered per merged event; reference the result with {{digest_items}} in the body"
          >
            <Input
              className="font-mono"
              placeholder="- {{title}}"
              value={step.digest.itemTemplate ?? ''}
              onChange={(e) =>
                patch({
                  digest: { ...step.digest!, itemTemplate: e.target.value || undefined },
                })
              }
            />
          </Field>
        )}

        {/* Full conditions builder — lives only here. */}
        <div>
          <span className="mb-1.5 block text-[12px] font-medium text-t2">
            Send only if <span className="text-t3">(all must pass)</span>
          </span>
          {conditions.length > 0 && (
            <div className="mb-2 space-y-2">
              {conditions.map((c, j) => {
                const valueless = c.op === 'exists' || c.op === 'not_exists';
                return (
                  <div key={j} className="flex items-center gap-2">
                    <Input
                      className="flex-1 font-mono"
                      placeholder="payload.field"
                      aria-label={`Condition ${j + 1} field`}
                      value={c.field}
                      onChange={(e) => updateCond(j, { field: e.target.value })}
                    />
                    <select
                      aria-label={`Condition ${j + 1} operator`}
                      className={`${selectCls} !w-auto`}
                      value={c.op}
                      onChange={(e) => updateCond(j, { op: e.target.value })}
                    >
                      {OPS.map((op) => (
                        <option key={op} value={op} className="bg-surface">
                          {op}
                        </option>
                      ))}
                    </select>
                    {!valueless && (
                      <Input
                        className="flex-1"
                        placeholder="value"
                        aria-label={`Condition ${j + 1} value`}
                        value={String(c.value ?? '')}
                        onChange={(e) => updateCond(j, { value: e.target.value })}
                      />
                    )}
                    <button
                      type="button"
                      aria-label={`Remove condition ${j + 1}`}
                      onClick={() => setConditions(conditions.filter((_, k) => k !== j))}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-t3 transition-colors hover:bg-elevated hover:text-t1"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {conditions.length === 0 ? (
            <>
              <button
                type="button"
                onClick={addCondition}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-bd py-2.5 text-[12px] font-medium text-t2 transition-colors hover:border-bd-strong hover:bg-elevated hover:text-t1"
              >
                <Plus className="h-3.5 w-3.5" /> Add a condition
              </button>
              <p className="mt-1.5 text-[11px] text-t3">
                With none, this step runs for every trigger.
              </p>
            </>
          ) : (
            <Button variant="secondary" onClick={addCondition}>
              <Plus className="h-3.5 w-3.5" /> Add condition
            </Button>
          )}
        </div>

        {i > 0 && (
          <div>
            <span className="mb-1.5 block text-[12px] font-medium text-t2">Skip gate</span>
            <div className="flex items-center gap-2">
              <Toggle
                checked={skipOn}
                onChange={(on) =>
                  patch({
                    skipIfStep: on
                      ? { stepIndex: i - 1, statusIn: [GATE_STATES[0]] }
                      : undefined,
                  })
                }
                label="Skip this step based on an earlier step"
              />
              <span className="text-[12px] text-t2">Skip if an earlier step already landed</span>
            </div>
            {skipOn && step.skipIfStep && (
              <div className="mt-2 flex items-center gap-1.5 text-[12px] text-t2">
                <span>skip if step</span>
                <select
                  aria-label="Earlier step"
                  className={`${selectCls} !w-auto`}
                  value={step.skipIfStep.stepIndex}
                  onChange={(e) =>
                    patch({
                      skipIfStep: { ...step.skipIfStep!, stepIndex: Number(e.target.value) },
                    })
                  }
                >
                  {Array.from({ length: i }, (_, n) => (
                    <option key={n} value={n} className="bg-surface">
                      {n + 1}
                    </option>
                  ))}
                </select>
                <span>is already</span>
                <select
                  aria-label="Gate state"
                  className={`${selectCls} !w-auto`}
                  value={step.skipIfStep.statusIn[0] ?? GATE_STATES[0]}
                  onChange={(e) =>
                    patch({ skipIfStep: { ...step.skipIfStep!, statusIn: [e.target.value] } })
                  }
                >
                  {GATE_STATES.map((s) => (
                    <option key={s} value={s} className="bg-surface">
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {stepInvalid(step) && (
          <p className="flex items-center gap-1.5 text-[12px] text-t3">
            <span
              aria-hidden
              className="inline-block h-[7px] w-[7px] rounded-full"
              style={{ background: 'var(--warn)' }}
            />
            This step needs a body or a template before the workflow can save.
          </p>
        )}
      </div>
    </div>
  );
}
