/**
 * The workflow FLOW canvas. Steps run top-to-bottom on a single spine; a step
 * that may be skipped at run time (isConditional) is drawn with a labeled
 * BYPASS — a dashed route that leaves the spine above the card, runs down a
 * right gutter, and rejoins below — so "this step is optional" is legible at a
 * glance. Read-only over the draft: it only adds / removes / moves / navigates.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Mail,
  MessageSquare,
  Plus,
  Smartphone,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '../../ui';
import { useWorkflow } from './WorkflowProvider';
import {
  CHANNELS,
  CHANNEL_LABEL,
  gateLabel,
  humanSeconds,
  isConditional,
  stepInvalid,
  stepSummary,
  timingLabel,
  type Step,
} from './types';

/* ------------------------------------------------------------------ */
/* Geometry — pixel constants the SVG bypass path is drawn against.     */
/* ------------------------------------------------------------------ */
const CONN_NORMAL = 60; // entry-connector height for a plain step
const CONN_COND = 96; //   taller entry connector for a gated step (fits the gate marker)
const EXIT_COND = 46; //   exit stub below a gated card (where the bypass rejoins)
const GUTTER = 22; //      distance of the bypass line in from the block's right edge
const CORNER = 18; //      bypass corner radius
const DIVERGE_Y = CONN_COND - 8; // spine y where the bypass peels off (just above the card)

const CHANNEL_ICON: Record<string, LucideIcon> = {
  email: Mail,
  inapp: Bell,
  sms: MessageSquare,
  push: Smartphone,
};

/** Card width tracks the lane but always leaves ≥48px each side for the gutter. */
const CARD_WIDTH: CSSProperties = { width: 'min(384px, calc(100% - 96px))' };

/* ================================================================== */
/* Canvas root                                                         */
/* ================================================================== */
export function WorkflowCanvas() {
  const { steps, isNew, routeKey } = useWorkflow();
  const location = useLocation();

  const base = isNew ? '/workflows/new' : `/workflows/${routeKey}`;
  const selected = (() => {
    const m = location.pathname.match(/steps\/(\d+)/);
    return m ? Number(m[1]) : -1;
  })();

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex w-full max-w-[500px] flex-col items-stretch px-4 py-10">
        <TriggerNode />

        {steps.length === 0 ? (
          <EmptyFlow />
        ) : (
          steps.map((step, i) => (
            <StepBlock
              key={i}
              step={step}
              index={i}
              last={i === steps.length - 1}
              base={base}
              selected={selected === i}
            />
          ))
        )}

        {steps.length > 0 && <EndConnector atIndex={steps.length} />}
      </div>
    </div>
  );
}

/* ================================================================== */
/* Trigger                                                             */
/* ================================================================== */
function TriggerNode() {
  const { wfKey } = useWorkflow();
  return (
    <div className="flex flex-col items-center">
      <div className="inline-flex items-center gap-2 rounded-full border border-bd bg-surface px-3 py-1.5">
        <Dot color="var(--accent)" />
        <span className="font-mono text-[12px] text-t1">{wfKey || 'workflow-key'}</span>
        <span className="text-[11px] uppercase tracking-wider text-t3">trigger</span>
      </div>
    </div>
  );
}

/* ================================================================== */
/* One step: entry connector + card (+ exit stub & bypass if gated)    */
/* ================================================================== */
function StepBlock({
  step,
  index,
  last,
  base,
  selected,
}: {
  step: Step;
  index: number;
  last: boolean;
  base: string;
  selected: boolean;
}) {
  const cond = isConditional(step, index);
  const [ref, size] = useMeasure<HTMLDivElement>();

  if (!cond) {
    return (
      <div className="flex flex-col items-stretch">
        <Connector timing={timingLabel(step)} atIndex={index} height={CONN_NORMAL} />
        <div className="flex w-full justify-center">
          <StepNode step={step} index={index} last={last} base={base} selected={selected} />
        </div>
      </div>
    );
  }

  // Gated step: measure the whole block so the SVG bypass spans connector→card→stub.
  return (
    <div ref={ref} className="relative flex flex-col items-stretch">
      <BypassLayer w={size.w} h={size.h} />

      <div className="relative z-[1] flex flex-col items-stretch">
        <Connector
          timing={timingLabel(step)}
          atIndex={index}
          height={CONN_COND}
          gate={gateLabel(step, index)}
        />
        <div className="flex w-full justify-center">
          <StepNode step={step} index={index} last={last} base={base} selected={selected} />
        </div>
        {/* exit stub: a short spine segment the bypass rejoins below the card */}
        <div className="relative" style={{ height: EXIT_COND }}>
          <Spine />
        </div>
      </div>
    </div>
  );
}

/** The dashed skip-route drawn in the right gutter, plus its "skip" tag. */
function BypassLayer({ w, h }: { w: number; h: number }) {
  if (w <= 0 || h <= 0) return null;
  const cx = w / 2;
  const gx = w - GUTTER;
  const mergeY = h - EXIT_COND / 2;
  const d = [
    `M ${cx} ${DIVERGE_Y}`,
    `L ${gx - CORNER} ${DIVERGE_Y}`,
    `Q ${gx} ${DIVERGE_Y} ${gx} ${DIVERGE_Y + CORNER}`,
    `L ${gx} ${mergeY - CORNER}`,
    `Q ${gx} ${mergeY} ${gx - CORNER} ${mergeY}`,
    `L ${cx} ${mergeY}`,
  ].join(' ');

  return (
    <>
      <svg
        className="pointer-events-none absolute inset-0"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        aria-hidden
        style={{ zIndex: 0 }}
      >
        <path
          d={d}
          fill="none"
          stroke="var(--bd-strong)"
          strokeWidth={1.5}
          strokeDasharray="5 4"
          strokeLinecap="round"
        />
      </svg>
      {/* label riding the vertical run of the route */}
      <span
        className="pointer-events-none absolute z-[1] -translate-x-1/2 -translate-y-1/2 rounded bg-app px-1.5 font-mono text-[10px] uppercase tracking-wide text-t3"
        style={{ left: gx, top: (DIVERGE_Y + (h - EXIT_COND / 2)) / 2 }}
      >
        skip
      </span>
    </>
  );
}

/* ================================================================== */
/* Connector between nodes: spine + timing chip + gate marker + add    */
/* ================================================================== */
function Connector({
  timing,
  atIndex,
  height,
  gate,
}: {
  timing: string;
  atIndex: number;
  height: number;
  gate?: string | null;
}) {
  return (
    <div className="relative w-full" style={{ height }}>
      <Spine />
      {/* timing chip sits on the line near the top */}
      <ChipOnLine top={8}>
        <span className="font-mono text-[11px] text-t2">{timing}</span>
      </ChipOnLine>
      {/* add-between control, on the line below the timing chip */}
      <div className="absolute left-1/2 -translate-x-1/2" style={{ top: 32 }}>
        <AddButton atIndex={atIndex} />
      </div>
      {/* gate marker just above the card, where the bypass peels off */}
      {gate && (
        <div
          className="absolute left-1/2 flex max-w-[74%] -translate-x-1/2 items-center gap-1.5"
          style={{ top: DIVERGE_Y - 26 }}
        >
          <span
            aria-hidden
            className="h-[9px] w-[9px] shrink-0 rotate-45 border border-bd-strong bg-app"
          />
          <span className="truncate rounded bg-elevated px-1.5 py-0.5 text-[11px] text-t2">
            {gate}
          </span>
        </div>
      )}
    </div>
  );
}

/** Final add affordance after the last node. */
function EndConnector({ atIndex }: { atIndex: number }) {
  return (
    <div className="relative w-full" style={{ height: CONN_NORMAL }}>
      <Spine to="50%" />
      <div className="absolute left-1/2 -translate-x-1/2" style={{ top: CONN_NORMAL / 2 - 11 }}>
        <AddButton atIndex={atIndex} label="Add step" />
      </div>
    </div>
  );
}

/** Vertical spine line, centered. `to` caps its height (e.g. the end stub). */
function Spine({ to = '100%' }: { to?: string }) {
  return (
    <span
      aria-hidden
      className="absolute left-1/2 top-0 -translate-x-1/2 bg-bd-strong"
      style={{ width: 1, height: to }}
    />
  );
}

function ChipOnLine({ top, children }: { top: number; children: ReactNode }) {
  return (
    <div className="absolute left-1/2 -translate-x-1/2 bg-app px-1.5" style={{ top }}>
      {children}
    </div>
  );
}

/* ================================================================== */
/* Step node (the card)                                                */
/* ================================================================== */
function StepNode({
  step,
  index,
  last,
  base,
  selected,
}: {
  step: Step;
  index: number;
  last: boolean;
  base: string;
  selected: boolean;
}) {
  const { moveStep, removeStep } = useWorkflow();
  const navigate = useNavigate();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const cond = isConditional(step, index);
  const gate = gateLabel(step, index);
  const invalid = stepInvalid(step);
  const usedSubject = Boolean(step.subject?.trim());
  const bodySnippet = step.body.trim().replace(/\s+/g, ' ');
  const Icon = CHANNEL_ICON[step.channel] ?? Mail;

  // Single click opens the drawer; a double click opens the full editor. The
  // single click waits out a double-click window before acting, and a second
  // click (e.detail > 1) cancels it and jumps to the editor. The window must be
  // long enough to catch a normal-speed double-click — too short (was 180ms)
  // and the drawer opens before the second click lands. A native onDoubleClick
  // backs this up for any double the counter misses.
  const openDrawer = () => navigate(`${base}/steps/${index}`);
  const openEditor = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    navigate(`${base}/steps/${index}/editor`);
  };
  const onClick = (e: React.MouseEvent) => {
    if (e.detail > 1) {
      openEditor();
      return;
    }
    timer.current = setTimeout(() => {
      openDrawer();
      timer.current = null;
    }, 280);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navigate(`${base}/steps/${index}`);
    }
  };

  return (
    <div className="group relative" style={CARD_WIDTH}>
      {/* hover / focus action bar — floats above the card, outside the click target */}
      <div
        className="absolute -top-3 right-2 z-20 flex items-center gap-0.5 rounded-md border border-bd bg-surface p-0.5 opacity-0 shadow-sm transition-opacity duration-200 ease-out group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <IconAction
          label="Move step up"
          disabled={index === 0}
          onClick={() => moveStep(index, -1)}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </IconAction>
        <IconAction
          label="Move step down"
          disabled={last}
          onClick={() => moveStep(index, 1)}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </IconAction>
        <IconAction label="Delete step" danger onClick={() => removeStep(index)}>
          <Trash2 className="h-3.5 w-3.5" />
        </IconAction>
      </div>

      <div
        role="button"
        tabIndex={0}
        aria-label={`Step ${index + 1}: ${CHANNEL_LABEL[step.channel] ?? step.channel}`}
        onClick={onClick}
        onDoubleClick={openEditor}
        onKeyDown={onKeyDown}
        className={`block w-full cursor-pointer rounded-lg border bg-surface p-3.5 text-left transition-colors duration-150 hover:border-bd-strong ${
          selected ? 'border-bd-strong bg-elevated' : 'border-bd'
        }`}
      >
        {/* header */}
        <div className="flex items-center gap-2">
          {selected && <Dot color="var(--accent)" />}
          <Icon className="h-4 w-4 shrink-0 text-t2" aria-hidden />
          <span className="text-[13px] font-medium text-t1">
            {CHANNEL_LABEL[step.channel] ?? step.channel}
          </span>
          <span className="ml-auto shrink-0 rounded bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-t3">
            {timingLabel(step)}
          </span>
        </div>

        {/* content */}
        <p className="mt-2 truncate text-[13px] text-t1">{stepSummary(step)}</p>
        {usedSubject && bodySnippet && (
          <p className="mt-0.5 truncate text-[12px] text-t3">{bodySnippet}</p>
        )}

        {/* footer chips */}
        {(cond || step.digest || invalid) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {cond && (
              <Chip>
                <Dot color="var(--info)" />
                <span className="truncate">{gate ?? 'conditional'}</span>
              </Chip>
            )}
            {step.digest?.windowSeconds ? (
              <Chip>
                <Dot color="var(--t3)" />
                <span>
                  digest <span className="font-mono">{humanSeconds(step.digest.windowSeconds)}</span>
                </span>
              </Chip>
            ) : null}
            {invalid && (
              <Chip>
                <Dot color="var(--warn)" />
                <span>needs content</span>
              </Chip>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function IconAction({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`grid h-6 w-6 place-items-center rounded transition-colors duration-150 disabled:opacity-30 disabled:pointer-events-none ${
        danger ? 'text-t3 hover:bg-elevated hover:text-err' : 'text-t3 hover:bg-elevated hover:text-t1'
      }`}
    >
      {children}
    </button>
  );
}

/* ================================================================== */
/* Add-step control + channel popover (portalled to escape clipping)   */
/* ================================================================== */
function AddButton({ atIndex, label }: { atIndex: number; label?: string }) {
  const { addStep } = useWorkflow();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = () => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    const MENU_W = 200;
    const MENU_H = CHANNELS.length * 40 + 12;
    const left = Math.min(
      Math.max(r.left + r.width / 2 - MENU_W / 2, 8),
      window.innerWidth - MENU_W - 8,
    );
    const below = r.bottom + 8;
    const top = below + MENU_H > window.innerHeight ? r.top - 8 - MENU_H : below;
    setPos({ left, top });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !anchorRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (channel: string) => {
    addStep(atIndex, channel);
    setOpen(false);
  };

  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        {label ? (
          <Button variant="secondary" aria-expanded={open} onClick={openMenu}>
            <Plus className="h-3.5 w-3.5" />
            {label}
          </Button>
        ) : (
          <button
            type="button"
            aria-label="Insert step"
            aria-expanded={open}
            onClick={openMenu}
            className={`grid h-[22px] w-[22px] place-items-center rounded-full border bg-app text-t3 transition-colors duration-150 hover:border-bd-strong hover:text-t1 ${
              open ? 'border-bd-strong text-t1' : 'border-bd'
            }`}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </span>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Choose a channel"
            className="fixed z-50 w-[200px] overflow-hidden rounded-lg border border-bd bg-surface p-1 shadow-lg"
            style={{ left: pos.left, top: pos.top, animation: 'modal-in 150ms ease' }}
          >
            <p className="px-2 pb-1 pt-1.5 text-[11px] uppercase tracking-wider text-t3">
              Add step
            </p>
            {CHANNELS.map((c) => {
              const Icon = CHANNEL_ICON[c] ?? Mail;
              return (
                <button
                  key={c}
                  type="button"
                  role="menuitem"
                  onClick={() => choose(c)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-[13px] text-t1 transition-colors duration-150 hover:bg-elevated focus-visible:bg-elevated"
                >
                  <Icon className="h-4 w-4 text-t2" aria-hidden />
                  {CHANNEL_LABEL[c]}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

/* ================================================================== */
/* Empty flow                                                          */
/* ================================================================== */
function EmptyFlow() {
  return (
    <div className="flex flex-col items-center">
      <div className="relative w-full" style={{ height: CONN_NORMAL }}>
        <Spine to="50%" />
      </div>
      <div
        className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-bd bg-surface px-6 py-8 text-center"
        style={CARD_WIDTH}
      >
        <p className="text-[13px] font-medium text-t1">No steps yet</p>
        <p className="max-w-[220px] text-[12px] text-t3">
          Add the first step to start building this workflow.
        </p>
        <AddButton atIndex={0} label="Add your first step" />
      </div>
    </div>
  );
}

/* ================================================================== */
/* Small primitives                                                    */
/* ================================================================== */
function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-t2">{children}</span>
  );
}

/** offsetWidth/Height-based size (includes padding) so the spine sits at w/2. */
function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}
