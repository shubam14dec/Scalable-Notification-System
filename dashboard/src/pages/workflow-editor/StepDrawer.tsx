/**
 * The timing DRAWER — a right-side panel for the "when does this step fire"
 * subset: channel, delay, digest window, a read-only conditions summary, the
 * cross-step skip gate. Message content is NOT previewed or edited here — each
 * channel structures its content differently, so the drawer just links to the
 * per-channel content editor via an "Edit content →" button; the full editor
 * (subject/body/templates + the conditions builder) lives on the
 * StepEditorPage. Every edit writes the
 * live draft through updateStep(); the layout header owns Save.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import gsap from 'gsap';
import { ArrowDown, ArrowUp, Bell, Mail, MessageSquare, Smartphone, Trash2, X } from 'lucide-react';
import { Button, Field, Input, Mono } from '../../ui';
import { useWorkflow } from './WorkflowProvider';
import {
  CHANNEL_LABEL,
  GATE_STATES,
  activeConditions,
  gateLabel,
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

function Section({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div>
      <span className="mb-1.5 block text-[12px] font-medium text-t2">{label}</span>
      {children}
      {hint && <p className="mt-1 text-[11px] text-t3">{hint}</p>}
    </div>
  );
}

export default function StepDrawer() {
  const { index } = useParams();
  const navigate = useNavigate();
  const { steps, routeKey, isNew, updateStep, removeStep, moveStep } = useWorkflow();
  const i = Number(index);
  const step = steps[i];
  const base = isNew ? '/workflows/new' : `/workflows/${routeKey}`;

  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  // GSAP reveal. useLayoutEffect + .from() sets the start state before paint, so
  // there's no flash of the panel at its final position. gsap.matchMedia keeps
  // it accessible: a full slide when motion is welcome, a quick fade (never an
  // instant pop) when the OS asks to reduce motion.
  useLayoutEffect(() => {
    const ctx = gsap.context(() => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        if (scrimRef.current)
          gsap.from(scrimRef.current, { opacity: 0, duration: 0.25, ease: 'power2.out' });
        if (panelRef.current)
          gsap.from(panelRef.current, { xPercent: 100, duration: 0.44, ease: 'power3.out' });
      });
      mm.add('(prefers-reduced-motion: reduce)', () => {
        gsap.from([scrimRef.current, panelRef.current].filter(Boolean), {
          opacity: 0,
          duration: 0.15,
          ease: 'none',
        });
      });
    });
    return () => ctx.revert();
  }, []);

  // Escape closes back to the flow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && navigate(base);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [base, navigate]);

  // Step removed out from under us (e.g. delete): return to the flow.
  useEffect(() => {
    if (!step) navigate(base, { replace: true });
  }, [step, base, navigate]);
  if (!step) return null;

  const patch = (next: Partial<Step>) => updateStep(i, { ...step, ...next });

  const setDigestWindow = (raw: string) => {
    const seconds = Math.max(0, Number(raw) || 0);
    patch({ digest: seconds > 0 ? { ...step.digest, windowSeconds: seconds } : undefined });
  };

  const Icon = CHANNEL_ICON[step.channel] ?? Mail;
  const gate = gateLabel(step, i);
  const condCount = activeConditions(step).length;
  const skipOn = i > 0 && Boolean(step.skipIfStep);

  return (
    <>
      {/* Scrim anchors the drawer to the whole viewport and closes on click. */}
      <div
        ref={scrimRef}
        className="fixed inset-0 z-40"
        style={{ background: 'var(--overlay)' }}
        onMouseDown={() => navigate(base)}
        aria-hidden
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-label={`${CHANNEL_LABEL[step.channel]} step ${i + 1} — timing`}
        className="fixed inset-y-0 right-0 z-50 flex w-[380px] max-w-[88vw] flex-col border-l border-bd bg-surface"
      >
      {/* header */}
      <div className="flex items-center gap-2 border-b border-bd px-4 py-3">
        <Icon className="h-4 w-4 text-t2" aria-hidden />
        <span className="text-[13px] font-medium text-t1">{CHANNEL_LABEL[step.channel]}</span>
        <Mono className="text-t3">step {i + 1}</Mono>
        <button
          onClick={() => navigate(base)}
          aria-label="Close"
          className="ml-auto grid h-7 w-7 place-items-center rounded-md text-t3 transition-colors hover:bg-elevated hover:text-t1"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* scrolling body */}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <Field label="Delay" hint="Seconds to wait before this step — 0 sends immediately">
          <Input
            type="number"
            min={0}
            className="font-mono"
            value={step.delaySeconds ?? 0}
            onChange={(e) => patch({ delaySeconds: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>

        <Field
          label="Digest window"
          hint="Seconds to batch matching events into one send — 0 turns digest off"
        >
          <Input
            type="number"
            min={0}
            className="font-mono"
            value={step.digest?.windowSeconds ?? 0}
            onChange={(e) => setDigestWindow(e.target.value)}
          />
        </Field>

        <Section label="Conditions">
          {gate ? (
            <div className="rounded-md border border-bd bg-elevated px-3 py-2">
              <div className="flex items-center gap-1.5 text-[12px] text-t2">
                <span
                  aria-hidden
                  className="inline-block h-[7px] w-[7px] rounded-full"
                  style={{ background: 'var(--accent)' }}
                />
                {condCount > 0
                  ? `${condCount} condition${condCount > 1 ? 's' : ''}`
                  : 'Gated'}
              </div>
              <p className="mt-1 text-[11px] text-t3">{gate}</p>
            </div>
          ) : (
            <p className="text-[12px] text-t3">Runs for every trigger.</p>
          )}
          <p className="mt-1.5 text-[11px] text-t3">Edit conditions on the content page.</p>
        </Section>

        {i > 0 && (
          <Section label="Skip gate">
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
          </Section>
        )}

        <Section
          label="Content"
          hint="This channel's message — subject, body, and layout — is edited on its own page."
        >
          <Button variant="primary" onClick={() => navigate(`${base}/steps/${i}/editor`)}>
            Edit content →
          </Button>
        </Section>
      </div>

      {/* footer — move / delete */}
      <div className="flex items-center gap-1 border-t border-bd px-4 py-3">
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
          className="ml-auto"
          onClick={() => {
            removeStep(i);
            navigate(base);
          }}
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </div>
    </aside>
    </>
  );
}
