import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * U3 — the frame every signed-out page wears: login, request access, invited
 * signup, forgot password, and /reset-password.
 *
 * One canvas — asyncify.org's near-black, page-wide and theme-invariant —
 * with two columns floating on it inside a centered max-width: the brand
 * column (bell, headline, ticker) with real margin off the left edge, and the
 * form card with matching margin on the right. The card itself stays on the
 * app's theme tokens. The left column is the pitch; the card is the door.
 *
 * Presentation only: nothing in this file submits, fetches a credential, or
 * decides a flow. The one network call is a single /health measurement for the
 * pulse line, which nothing else reads.
 */

/** True when the visitor has asked their OS for less motion. Read on demand
 *  (not stored in state): every caller wants it at the moment of a decision. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The breakpoint the brand panel appears at, in one place: the login success
 *  ring is a no-op below it, and the JS must agree with the CSS about where. */
const PANEL_MIN_WIDTH = 900;
const PANEL_QUERY = `(min-width: ${PANEL_MIN_WIDTH}px)`;
export function brandPanelVisible(): boolean {
  return window.matchMedia(PANEL_QUERY).matches;
}

/** Live answer to a media query. Used so the panel's one interval exists only
 *  while the panel is actually on screen — CSS already hides it, and a hidden
 *  element's animations do not tick, but a setInterval does. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    onChange();
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * The mark — the delivered-dot inside the ripple ring, the same glyph as
 * dashboard/public/favicon.svg, inlined so it can be animated and so nothing
 * has to load (the SPA ships `script-src 'self'`; an <img> to a file would
 * work, but a file cannot ring).
 *
 * Drawn in currentColor, monochrome, deliberately: the favicon paints its dot
 * in the delivery-status green, and this design system mints color only for
 * status — on these pages that budget is spent on the pulse dot. One token
 * swap in the caller's text color is all it would take to change that back.
 */
export function RippleMark({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      focusable="false"
      className={className}
    >
      <circle
        cx="16"
        cy="16"
        r="10.5"
        stroke="currentColor"
        strokeOpacity="0.45"
        strokeWidth="1.25"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx="16" cy="16" r="5" fill="currentColor" />
    </svg>
  );
}

/** The eight things the platform says, on the marketing site's own terms. The
 *  ✓ is typography, not a status readout — it stays the same grey as its line. */
const PROOF_LINES = [
  'delivered · email · 142ms',
  'webhook verified ✓',
  'agent replied · 2.1s',
  'in-app · read · 0.3s',
  'delivered · slack · 89ms',
  'digest window closed · 3 queued',
  'delivered · sms · 1.2s',
  'escalated to human · 4s',
];

/** One line every 2.2s; each line lives for three of those. Eight lines makes
 *  a ~17.6s lap, and the start index is random so two tabs never march in step. */
const TICK_MS = 2200;

/**
 * The proof ticker. One interval and at most three nodes: every line animates
 * its entire drift itself, absolutely positioned, so no line ever reflows
 * another and there is no rAF loop and no canvas to pay for.
 */
function ProofTicker() {
  const [start] = useState(() => Math.floor(Math.random() * PROOF_LINES.length));
  const [reduced] = useState(prefersReducedMotion);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, [reduced]);

  // Reduced motion gets one line, standing still — the content is decorative,
  // and a feed that drifts is exactly what was asked not to happen.
  const live = reduced ? [0] : [tick - 2, tick - 1, tick].filter((i) => i >= 0);

  return (
    <div className="relative h-[54px] w-full overflow-hidden" aria-hidden>
      {live.map((i) => (
        <div
          key={i}
          className="auth-ticker-line absolute inset-x-0 bottom-0 font-mono text-[12px] leading-[18px]"
          style={{ color: 'var(--auth-muted)' }}
        >
          {PROOF_LINES[(start + i) % PROOF_LINES.length]}
        </div>
      ))}
    </div>
  );
}

/**
 * The brand panel. Hidden below 900px — on a phone the form is the whole page,
 * and a decorative half-screen above it is just scrolling.
 *
 * `ringing` fires the one-shot success ring; the caller navigates 400ms later.
 */
function BrandPanel({ ringing }: { ringing: boolean }) {
  const onScreen = useMediaQuery(PANEL_QUERY);
  // The page root carries .auth-canvas (the palette lives there); this column
  // only sizes and arranges. CSS hides it below the breakpoint; `onScreen`
  // also stops paying for the ticker interval.
  return (
    <div className="hidden w-full max-w-[580px] shrink flex-col items-center min-[900px]:flex">
      {/* THE BELL — the site hero's own drawing, path for path (index.html
          scene 1): crown, deliberately asymmetric profiles, the sagging
          mouth, lip curls, yoke, the clapper whose ball is the delivered-dot
          (the identity green, same as the site), the foundry inscriptions
          cast on the skirt, and the rim glint. The thread runs from the
          panel's very top edge to the crown, so it hangs the way it hangs on
          asyncify.org. It hangs STILL (his call); the rim glint surfaces
          every ~7s, and a successful sign-in rings a ripple out of the
          clapper ball. */}
      <svg
        className="auth-bell -translate-x-6"
        width="290"
        viewBox="-70 -80 140 210"
        fill="none"
        aria-hidden
        focusable="false"
      >
        <path className="ab-thread" d="M 0 -80 L 0 0" />
        <g className="auth-bell-swing">
          <defs>
            <path id="auth-skirt-l" d="M -48.1 102.7 C -38.8 91.7 -38.6 77 -36.1 63.5" fill="none" />
            <path id="auth-skirt-r" d="M 37.6 68.7 C 39.2 79 40 89.4 45.8 98.4" fill="none" />
          </defs>
          <text className="ab-foundry">
            <textPath href="#auth-skirt-l" startOffset="50%" textAnchor="middle">ASYNCIFY</textPath>
          </text>
          <text className="ab-foundry">
            <textPath href="#auth-skirt-r" startOffset="50%" textAnchor="middle">ENGINE</textPath>
          </text>
          <g>
            <path className="ab-line ab-detail" d="M 0 26 C 0.7 46 -0.5 74 0.3 90" />
            <circle className="ab-ball" cx="0.3" cy="99" r="9.5" />
          </g>
          <g>
            <path className="ab-line ab-sil" d="M 0 0 C -7.8 1.4 -8.6 14.6 -0.2 16.4 C 8 14.8 7.4 1.6 0 0 Z" />
            <path className="ab-line ab-sil" d="M -0.6 17.4 C -8 17.7 -19.5 24.5 -25.5 37.8 C -31 49.8 -33.6 65 -35.6 80 C -37.4 91.6 -41.6 101.4 -49.6 108.4" />
            <path className="ab-line ab-sil" d="M 0.6 17.2 C 8.4 17.6 20.2 24.2 26.1 37.6 C 31.6 49.6 34.2 65 36.2 80 C 38 91.6 42.2 101.2 50.2 108" />
            <path className="ab-line ab-sil" d="M -49.6 108.4 C -31 115.8 30.4 115.4 50.2 108" />
            <path className="ab-line ab-detail" d="M -49.6 108.4 C -50.9 109.9 -51.7 111.1 -52.3 112.6" />
            <path className="ab-line ab-detail" d="M 50.2 108 C 51.5 109.5 52.3 110.7 52.9 112.2" />
            <path className="ab-line ab-detail" d="M -3.6 25.2 C -1.2 22.9 1.4 22.9 3.6 25.4" />
            <path className="ab-glint" d="M 13.6 114.6 C 26.2 114.3 38.8 112.4 47.4 109" />
          </g>
        </g>
        {ringing && <circle className="ab-ring-out" cx="0.3" cy="99" r="12" />}
      </svg>

      {/* The site's headline, its exact composition: Geist Sans 400 with the
          payoff word alone in Instrument Serif italic — the same break, the
          same rhetoric. The serif ships as a static woff2 (public/fonts), so
          no dependency and no external origin. A <p>, not a heading: the
          page's one real heading is the form's title. */}
      <p className="auth-headline mt-12 -translate-x-6 text-center">
        {/* Exactly two lines, his call: the first segment must never wrap. */}
        <span className="whitespace-nowrap">Your product has something</span>
        <br />
        to <span className="auth-hl-accent">say.</span>
      </p>

      <div className="mt-auto self-stretch px-12 pb-10">{onScreen && <ProofTicker />}</div>
    </div>
  );
}

type Pulse = { state: 'checking' } | { state: 'ok'; ms: number } | { state: 'degraded' };

/**
 * The pulse line — the platform answering for itself, measured rather than
 * claimed. One /health round trip per page load, timed with performance.now(),
 * and no polling: a login page that heartbeats is a login page that costs
 * money at 10M users.
 *
 * The dot is the only color on this page, and it is a status readout, which is
 * the one thing the design system spends color on.
 */
function PulseLine() {
  const [pulse, setPulse] = useState<Pulse>({ state: 'checking' });
  // StrictMode runs mount effects twice in dev; one measurement means one.
  const measured = useRef(false);

  useEffect(() => {
    if (measured.current) return;
    measured.current = true;
    const t0 = performance.now();
    // No "still mounted?" flag on purpose: StrictMode's simulated unmount would
    // trip it, the latch above would skip the second run, and the line would
    // read "checking…" forever in dev. React 18 makes a setState after unmount
    // a silent no-op, so the latch alone is the whole guard.
    fetch('/health')
      .then((r) =>
        setPulse(
          r.ok ? { state: 'ok', ms: Math.round(performance.now() - t0) } : { state: 'degraded' },
        ),
      )
      .catch(() => setPulse({ state: 'degraded' }));
  }, []);

  const color =
    pulse.state === 'ok' ? 'var(--ok)' : pulse.state === 'degraded' ? 'var(--warn)' : 'var(--t3)';
  const label =
    pulse.state === 'ok'
      ? `operational · ${pulse.ms}ms`
      : pulse.state === 'degraded'
        ? 'degraded'
        : 'checking…';

  return (
    <p className="mt-8 flex items-center justify-center gap-1.5 font-mono text-[11px] text-t3">
      <span
        aria-hidden
        className="inline-block h-[6px] w-[6px] rounded-full"
        style={{ background: color }}
      />
      platform · {label}
    </p>
  );
}

/**
 * A receipt. Two of them exist: the invite ticket above a signup form, and the
 * confirmation a request-access submission turns into. Both are mono, hairline,
 * and torn along the bottom (.auth-ticket in styles.css).
 *
 * `stagger` lets the lines arrive in order rather than all at once — used where
 * the card IS the answer to something the visitor just did.
 */
export function Receipt({
  label,
  children,
  stagger = false,
  className = '',
}: {
  label: string;
  children: ReactNode;
  stagger?: boolean;
  className?: string;
}) {
  return (
    <div className={`auth-ticket border border-bd bg-surface px-3.5 pb-3.5 pt-3 ${className}`}>
      <div
        className={stagger ? 'auth-line flex items-center justify-between' : 'flex items-center justify-between'}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-t3">{label}</span>
        <RippleMark size={12} className="text-t3" />
      </div>
      <div className="mt-2 space-y-1">{children}</div>
    </div>
  );
}

/** One receipt line. `index` drives the stagger; unstaggered lines pass none. */
export function ReceiptLine({
  children,
  index,
  className = '',
}: {
  children: ReactNode;
  index?: number;
  className?: string;
}) {
  return (
    <p
      className={`${index === undefined ? '' : 'auth-line '}font-mono text-[12px] leading-relaxed text-t2 ${className}`}
      style={index === undefined ? undefined : { animationDelay: `${80 * (index + 1)}ms` }}
    >
      {children}
    </p>
  );
}

/**
 * The frame. `ringing` is only ever true on the login page, for the 400ms
 * between "you're in" and the navigation.
 */
export function AuthLayout({
  children,
  title,
  subtitle,
  ringing = false,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
  ringing?: boolean;
}) {
  return (
    // ONE canvas, his call from the reference layout: the site's near-black
    // covers the whole page, and BOTH columns float on it inside a centered
    // max-width — real margin off the left edge, a real gap between brand and
    // card, matching margin on the right. No more edge-to-edge half-panels.
    <div className="auth-canvas h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-[1200px] items-stretch justify-between gap-12 px-6 min-[900px]:px-14">
        <BrandPanel ringing={ringing} />
        {/* my-auto, not items-center: a centered flex item that outgrows a
            scrolling parent overflows past the top edge, out of reach. */}
        <div className="mx-auto my-auto w-full max-w-[400px] py-10 min-[900px]:mx-0 min-[900px]:shrink-0">
          {/* On desktop the brand lives on the bell column; the card carries
              none (his call). On mobile the column is gone, so a small
              wordmark stands above the card instead — in the canvas ink, the
              page background is the pinned near-black in every theme now. */}
          <div
            className="mb-4 flex items-center justify-center gap-2 min-[900px]:hidden"
            style={{ color: 'var(--auth-ink)' }}
          >
            <RippleMark size={15} />
            <span className="text-[15px] font-semibold tracking-tight">asyncify</span>
          </div>
          {/* The CARD — the Overview stat cards' own recipe (surface step in
              a 1px border, radius-md), structured the way polished SaaS front doors are: centered
              title, muted subtitle, the form, and — when a page ends with an
              AuthFooter — an attached band at the base. overflow-hidden lets
              the band reach the clipped corners. The pulse line stays
              OUTSIDE beneath: it speaks for the platform, not this form. */}
          <div className="overflow-hidden rounded-md border border-bd bg-surface p-8">
            <h1 className="text-center text-[16px] font-semibold">{title}</h1>
            {subtitle && (
              <p className="mt-1.5 text-center text-[12.5px] leading-relaxed text-t3">{subtitle}</p>
            )}
            <div className="mt-6">{children}</div>
          </div>
          <PulseLine />
        </div>
      </div>
    </div>
  );
}

/* The brand column no longer carries its own background — the page is the
   canvas — so its class only sizes and arranges it (see BrandPanel). */

/**
 * The switch-link band at a card's base — the polished-SaaS structural detail,
 * in our inks: one background step DOWN from the card, behind a hairline. It
 * escapes the card's p-8 with negative margins, so pages keep composing it as
 * plain trailing content.
 */
export function AuthFooter({ children }: { children: ReactNode }) {
  return (
    <p className="-mx-8 -mb-8 mt-7 border-t border-bd bg-app px-8 py-4 text-center text-[12px] text-t3">
      {children}
    </p>
  );
}
