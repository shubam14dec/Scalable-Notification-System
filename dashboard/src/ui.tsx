import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Copy, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useState } from 'react';

/* Monochrome component kit. Rule 1: no colored buttons, ever.
   Status colors appear ONLY through <StatusBadge> and <Dot>. */

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-medium transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap';
  const variants = {
    primary: 'bg-invert text-invert-t hover:opacity-90',
    secondary: 'border border-bd bg-transparent text-t1 hover:border-bd-strong hover:bg-elevated',
    ghost: 'text-t2 hover:text-t1 hover:bg-elevated',
    danger: 'border border-bd text-err hover:border-err/50 hover:bg-elevated',
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

export function Input({
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-8 w-full rounded-md border border-bd bg-transparent px-2.5 text-[13px] text-t1 placeholder:text-t3 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong ${className}`}
      {...props}
    />
  );
}

/**
 * An account-password field with a show/hide toggle. For ACCOUNT passwords
 * only (login, signup, reset, the change-password card) — pasted API keys and
 * webhook secrets keep the plain masked Input, where revealing is a different
 * decision (SecretReveal covers the agent case). The toggle is type="button"
 * so it can never submit the form it sits in, and the eye rides INSIDE the
 * input's box (pr-9 keeps typed text clear of it).
 */
export function PasswordInput({
  className = '',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={shown ? 'text' : 'password'} className={`pr-9 ${className}`} />
      <button
        type="button"
        aria-label={shown ? 'Hide password' : 'Show password'}
        onClick={() => setShown((s) => !s)}
        className="absolute inset-y-0 right-0 flex items-center px-2.5 text-t3 transition-colors hover:text-t1"
      >
        {shown ? (
          <EyeOff className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
        ) : (
          <Eye className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
        )}
      </button>
    </div>
  );
}

/**
 * The house dropdown. A native select element's open menu is painted by the OS and
 * ignores every token in styles.css — so the trigger AND the list are ours.
 *
 * Chrome only: the trigger copies `Input`'s idiom (h-8, 1px border, no fill),
 * the popover is one background step up (elevated) with a 1px bd-strong border
 * and NO shadow. Nothing here is ever colored — color stays reserved for
 * delivery status.
 *
 * Manners match a native select: controlled or uncontrolled, keyboard
 * navigation with DOM focus parked on the trigger (aria-activedescendant moves,
 * not focus), a hidden input so a <form>'s FormData still sees `name`, and
 * `type="button"` so a trigger inside a form never submits it.
 */
export function Select({
  value,
  defaultValue,
  onChange,
  options,
  name,
  ariaLabel,
  className = '',
  disabled,
}: {
  /** Controlled value. When provided, the component renders from props only. */
  value?: string;
  /** Uncontrolled initial value; ignored once `value` is provided. */
  defaultValue?: string;
  /** Called with the option's VALUE (a plain string, not an event). */
  onChange?: (value: string) => void;
  options: Array<{ value: string; label: ReactNode }>;
  /** Renders a hidden input so FormData still picks the choice up. */
  name?: string;
  ariaLabel?: string;
  /** Appended to the trigger — width/height/text-size overrides live here. */
  className?: string;
  disabled?: boolean;
}) {
  const [internal, setInternal] = useState(defaultValue ?? '');
  const current = value !== undefined ? value : internal;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    minWidth: number;
    maxWidth: number;
    maxHeight: number;
  } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const uid = useId();
  const listId = `${uid}-list`;

  // Native-select resolution, kept verbatim: a value matching no option falls
  // back to the FIRST option — for the label AND for what a form submits.
  // (Approvals synthesises its "(inactive)" option precisely because of this.)
  const matched = options.findIndex((o) => o.value === current);
  const selectedIndex = matched >= 0 ? matched : options.length > 0 ? 0 : -1;
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : null;
  const submitted = selectedIndex >= 0 ? options[selectedIndex].value : current;

  // Tailwind emits same-property utilities in ITS order, not the class string's,
  // so a call site's `h-7` would silently lose to a base `h-8`. Drop the base
  // value whenever the call site supplies its own.
  const hasHeight = /(?:^|\s)h-/.test(className);
  const textOverride = className.match(
    /(?:^|\s)(text-\[[^\]]+\]|text-(?:xs|sm|base|lg))(?=\s|$)/,
  )?.[1];
  const textCls = textOverride ?? 'text-[13px]';

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const GAP = 4;
    const EDGE = 8;
    const MAX = 256; // max-h-64
    const below = window.innerHeight - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const flip = below < Math.min(MAX, 160) && above > below;
    setPos({
      left: r.left,
      top: flip ? undefined : r.bottom + GAP,
      bottom: flip ? window.innerHeight - r.top + GAP : undefined,
      minWidth: r.width,
      maxWidth: Math.max(r.width, window.innerWidth - r.left - EDGE),
      maxHeight: Math.min(MAX, Math.max(96, flip ? above : below)),
    });
  }, []);

  const openList = useCallback(() => {
    if (disabled) return;
    place();
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }, [disabled, place, selectedIndex]);

  const commit = useCallback(
    (v: string) => {
      if (value === undefined) setInternal(v);
      onChange?.(v);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange, value],
  );

  // Outside dismissal has to clear BOTH refs: the portal is not a DOM child of
  // the trigger, so a trigger-only check closes the list on the option's own
  // mousedown and the click never lands (project lesson, learned the hard way).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && popRef.current?.contains(t)) return; // scrolling the list itself
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) openList();
        else setActive((i) => Math.min(i + 1, last));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) openList();
        else setActive((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        if (!open) break;
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        if (!open) break;
        e.preventDefault();
        setActive(last);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault(); // also stops Enter from submitting an enclosing form
        if (!open) openList();
        else if (options[active]) commit(options[active].value);
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && options[active] ? `${uid}-opt-${active}` : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={`inline-flex ${hasHeight ? '' : 'h-8'} items-center justify-between gap-1.5 rounded-md border border-bd bg-transparent px-2 ${textCls} text-t1 transition-colors duration-150 hover:border-bd-strong disabled:pointer-events-none disabled:opacity-50 ${className}`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{selectedLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-t3" strokeWidth={1.5} aria-hidden />
      </button>
      {name && <input type="hidden" name={name} value={submitted} />}
      {open &&
        pos &&
        createPortal(
          // Two nested divs on purpose (the EditPanel validation-tip pattern):
          // the outer one owns the fixed position, the inner one owns the
          // entrance — modal-in animates `transform`, and both on one element
          // would fight.
          <div
            ref={popRef}
            className="fixed z-50"
            style={{
              left: pos.left,
              top: pos.top,
              bottom: pos.bottom,
              minWidth: pos.minWidth,
              maxWidth: pos.maxWidth,
            }}
          >
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              className="overflow-y-auto rounded-md border border-bd-strong bg-elevated py-1"
              style={{ maxHeight: pos.maxHeight, animation: 'modal-in 150ms ease' }}
            >
              {options.map((o, i) => {
                const isSelected = i === selectedIndex;
                return (
                  <div
                    key={o.value}
                    id={`${uid}-opt-${i}`}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => commit(o.value)}
                    className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 ${textCls} ${
                      i === active ? 'bg-bd text-t1' : isSelected ? 'text-t1' : 'text-t2'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {/* Non-selected rows reserve the glyph's space so labels align. */}
                    {isSelected ? (
                      <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
                    ) : (
                      <span aria-hidden className="h-3.5 w-3.5 shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-t2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-t3">{hint}</span>}
    </label>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-bd bg-surface ${className}`}>{children}</div>
  );
}

/* The one place status colors are minted. Keep the vocabulary here. */
const STATUS_STYLES: Record<string, { color: string; label?: string }> = {
  sent: { color: 'var(--ok)' },
  delivered: { color: 'var(--ok)' },
  queued: { color: 'var(--info)' },
  sending: { color: 'var(--info)' },
  accepted: { color: 'var(--info)' },
  processing: { color: 'var(--info)' },
  completed: { color: 'var(--ok)' },
  retry: { color: 'var(--warn)' },
  failed: { color: 'var(--err)' },
  bounced: { color: 'var(--err)' },
  complaint: { color: 'var(--err)' },
  skipped: { color: 'var(--t3)' },
  merged: { color: 'var(--t3)' },
  active: { color: 'var(--info)' },
  resolved: { color: 'var(--ok)' },
  // Phase 26 (D8): handoff states. waiting_human = amber (attention-needing —
  // a customer is waiting, no teammate has picked it up), the same warn idiom
  // retry uses; human = info (a teammate is engaged, a live/in-progress state
  // like active — the label carries the distinction, not a new colour).
  waiting_human: { color: 'var(--warn)', label: 'waiting for human' },
  human: { color: 'var(--info)', label: 'human' },
  disabled: { color: 'var(--t3)' },
  // A10 the kill-switch. Amber, the same attention-needing warn idiom as
  // waiting_human and retry — and deliberately NOT the grey `disabled` uses.
  // Grey reads as "switched off and fine"; a paused agent is a live agent in
  // the middle of an incident, still taking messages, with its conversations
  // piling into a human queue. It is the one agent state someone must notice
  // from across the room, so it borrows the colour that means "look at this".
  paused: { color: 'var(--warn)' },
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? { color: 'var(--t3)' };
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-t2">
      <span
        aria-hidden
        className="inline-block h-[7px] w-[7px] rounded-full"
        style={{ background: style.color }}
      />
      {style.label ?? status}
    </span>
  );
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[12px] ${className}`}>{children}</span>;
}

export function Spinner() {
  return <Loader2 className="h-4 w-4 animate-spin text-t3" aria-label="Loading" />;
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-elevated ${className}`} />;
}

export function EmptyState({
  title,
  body,
  snippet,
}: {
  title: string;
  body: string;
  snippet?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="text-[15px] font-medium text-t1">{title}</p>
      <p className="max-w-sm text-t2">{body}</p>
      {snippet && (
        <pre className="mt-2 max-w-xl overflow-x-auto rounded-lg border border-bd bg-elevated p-4 text-left font-mono text-[12px] leading-relaxed text-t2">
          {snippet}
        </pre>
      )}
    </div>
  );
}

export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border border-bd bg-elevated px-2.5 py-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1">{value}</span>
      <button
        className="text-t3 transition-colors hover:text-t1"
        aria-label="Copy to clipboard"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" style={{ color: 'var(--ok)' }} /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /**
   * 'md' (default) is the form width every existing dialog uses. 'lg' exists
   * for dialogs whose content is a LIST the user has to read and compare —
   * A10's import preview is a field-by-field diff, and squeezing "System
   * prompt will change" into a form-width column makes a review surface into a
   * scroll. Widening the shared component beats a one-off dialog that drifts
   * from the house one.
   */
  size?: 'md' | 'lg';
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh]"
      style={{ background: 'var(--overlay)' }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label={title}
        // Tall content (e.g. the managed-LLM agent form) scrolls inside the
        // dialog instead of overflowing the viewport.
        className={`flex max-h-[84vh] w-full flex-col rounded-lg border border-bd bg-surface ${
          size === 'lg' ? 'max-w-xl' : 'max-w-md'
        }`}
        style={{ animation: 'modal-in 150ms ease' }}
      >
        <h2 className="shrink-0 px-5 pb-4 pt-5 text-[15px] font-semibold text-t1">{title}</h2>
        <div className="min-h-0 overflow-y-auto px-5 pb-5">{children}</div>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-center justify-between">
      <h1 className="text-[20px] font-semibold tracking-tight text-t1">{title}</h1>
      {action}
    </div>
  );
}

export const th = 'px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-t3';
export const td = 'px-3 py-2.5 border-t border-bd text-t1';
