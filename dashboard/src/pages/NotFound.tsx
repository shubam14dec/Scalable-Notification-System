import { Link, useLocation } from 'react-router-dom';
import { Button } from '../ui';
import { RippleMark } from './auth/AuthLayout';

/**
 * The 404 as the product would file it: a delivery attempt that found nobody
 * home, printed as a receipt — mono facts, a torn bottom edge (the invite
 * ticket's serration, same clip-path class), and one honest err dot, because
 * "undeliverable" is a genuine status and status is what color is for.
 *
 * Lives INSIDE the authed shell (sidebar stays — the fix for a wrong URL is
 * usually one click away on it); signed-out visitors never reach this.
 */
export default function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <RippleMark size={26} className="text-t3" />
      <p className="mt-5 font-mono text-[52px] font-medium leading-none tracking-tight text-t1">
        404
      </p>
      <p className="mt-3 text-[14px] text-t2">This page doesn&#39;t deliver.</p>

      {/* The receipt. Slightly tilted, the way a printed slip lands. */}
      <div
        className="auth-ticket mt-8 w-full max-w-[340px] border border-bd bg-surface px-5 pb-6 pt-4 text-left"
        style={{ transform: 'rotate(-1.2deg)', animation: 'modal-in 200ms ease' }}
      >
        <div className="mb-3 flex items-center justify-between border-b border-bd pb-2.5">
          <span className="font-mono text-[11px] tracking-[0.14em] text-t3">
            DELIVERY ATTEMPT
          </span>
          <RippleMark size={11} className="text-t3" />
        </div>
        <dl className="space-y-1.5 font-mono text-[12px]">
          <div className="flex gap-3">
            <dt className="w-[72px] shrink-0 text-t3">route</dt>
            <dd className="min-w-0 break-all text-t1">{pathname}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-[72px] shrink-0 text-t3">status</dt>
            <dd className="flex items-center gap-1.5 text-t1">
              <span aria-hidden className="h-[6px] w-[6px] rounded-full bg-err" />
              undeliverable
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-[72px] shrink-0 text-t3">attempts</dt>
            <dd className="text-t1">1 of 1 — that&#39;s plenty</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-[72px] shrink-0 text-t3">verdict</dt>
            <dd className="text-t1">nobody is routed here</dd>
          </div>
        </dl>
      </div>

      <Link to="/" className="mt-7">
        <Button variant="primary" type="button">
          Back to Overview
        </Button>
      </Link>
    </div>
  );
}
