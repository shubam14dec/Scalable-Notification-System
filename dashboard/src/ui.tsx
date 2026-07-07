import { useEffect, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
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
  disabled: { color: 'var(--t3)' },
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
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
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
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      style={{ background: 'var(--overlay)' }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label={title}
        className="w-full max-w-md rounded-lg border border-bd bg-surface p-5"
        style={{ animation: 'modal-in 150ms ease' }}
      >
        <h2 className="mb-4 text-[15px] font-semibold text-t1">{title}</h2>
        {children}
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
