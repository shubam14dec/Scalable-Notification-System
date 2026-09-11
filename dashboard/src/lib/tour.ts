import { driver, type DriveStep } from 'driver.js';
import { markTourDone } from './api';

/**
 * U5 — THE FIRST-RUN GUIDED TOUR.
 *
 * Seven stops around the sidebar, in the order a person actually needs them:
 * which organization and environment am I in -> what do I build (workflows) ->
 * where do channels plug in (connections, agents) -> how do I fire one (API
 * keys) -> what does it look like when it lands (inbox preview) -> where is the
 * evidence (activity). The last two are deliberately the pay-off: everything
 * before them is setup, and those two are where a new account first SEES the
 * product work.
 *
 * This module holds the WHAT (the stop list) and the HOW (one configured
 * driver). WHEN it runs — first sign-in only, desktop only, once — belongs to
 * components/Tour.tsx, and the Settings page calls `startTour` directly for a
 * replay. Splitting it that way is what lets the stop list be unit-tested
 * without a DOM.
 */

/**
 * The seven stops, as copy. Each names the `data-tour` value of the thing it
 * points at — never a positional selector. `nth-child` would have been quietly
 * correct today and quietly wrong the first time someone reorders the nav or
 * hides an item for a non-operator, and the failure would be a tour
 * confidently pointing at the wrong thing, which is worse than no tour at all.
 * The attributes live on Shell.tsx's environment switcher and nav items.
 */
const STOPS: Array<{ target: string; title: string; description: string }> = [
  {
    target: 'env',
    title: 'Your organization',
    description:
      'Development and Production environments — everything you see is scoped to the one selected here.',
  },
  {
    target: 'nav-workflows',
    title: 'Workflows',
    description:
      'A workflow is what you trigger — steps across email, SMS, push and in-app, with delays and digests.',
  },
  {
    target: 'nav-connections',
    title: 'Connections',
    description: 'Where channels plug in: Telegram, Slack, email inbound.',
  },
  {
    target: 'nav-agents',
    title: 'Agents',
    description:
      'The part that answers back — an AI agent picks up replies on any connected channel.',
  },
  {
    target: 'nav-keys',
    title: 'API keys',
    description: 'Trigger everything from your backend with a key from here.',
  },
  {
    target: 'nav-inbox-preview',
    title: 'Inbox preview',
    description: "Try the end-user's view — send a test message and watch it land live.",
  },
  {
    target: 'nav-activity',
    title: 'Activity',
    description: "Every message's full story — sent, delivered, opened — lives here.",
  },
];

/**
 * The stop list as driver sees it. Every popover sits to the RIGHT of its
 * target and is top-aligned with it — pinned rather than left to driver's
 * automatic placement, because every target is a row in a fixed left column
 * and "right, aligned to the row" is the only answer that is ever correct for
 * one. Automatic placement would flip sides on a narrow window and put the
 * popover on top of the sidebar it is describing.
 */
export const TOUR_STEPS: DriveStep[] = STOPS.map((stop) => ({
  element: `[data-tour="${stop.target}"]`,
  popover: {
    title: stop.title,
    description: stop.description,
    side: 'right',
    align: 'start',
  },
}));

/**
 * Below this the shell is a different shape (the 232px sidebar stops being a
 * fixed column) and every stop would be pointing at something the viewer cannot
 * see. The tour is SKIPPED there rather than adapted — and skipped without
 * clearing the flag, so the same account still gets its tour the first time it
 * opens the dashboard on a desktop.
 */
export const TOUR_MIN_VIEWPORT_WIDTH = 900;

/** Let the shell paint (and the nav mount) before the spotlight lands on it. */
export const TOUR_START_DELAY_MS = 600;

/** The popover's own class, so the house styling in styles.css is explicit
 *  about what it is restyling rather than reaching for every `.driver-popover`
 *  on the page. */
export const TOUR_POPOVER_CLASS = 'asyncify-tour';

/**
 * Run the tour. Returns nothing and throws nothing: it is a side effect on the
 * page, and the only thing a caller can do about a failure is not care.
 *
 * EVERY exit is the same exit. Finishing the seventh stop, pressing the close
 * button, clicking the overlay and pressing Escape all end in `onDestroyed`,
 * which fires POST /auth/tour-done exactly once — unawaited and with its errors
 * swallowed, because the tour is already over by then and there is nothing
 * useful to tell someone whose bookkeeping write failed. (A failed write means
 * the tour shows once more on the next sign-in. That is the right way to be
 * wrong.)
 *
 * `exited` is a local latch, not a module one: two independent runs (the
 * first-run tour and a later replay) each get their own.
 */
export function startTour(options: { onExit?: () => void } = {}): void {
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    void markTourDone().catch(() => {});
    options.onExit?.();
  };

  // Driver's spotlight animates its stage between stops and can smooth-scroll
  // to reach one. Both are motion the viewer did not ask for, so both are off
  // when the OS says to reduce it — the popovers still appear, they just cut
  // rather than glide. (The global `prefers-reduced-motion` rule in styles.css
  // crushes CSS durations; this is the JS-driven half it cannot reach.)
  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  driver({
    steps: TOUR_STEPS,
    animate: !reduceMotion,
    smoothScroll: !reduceMotion,
    showProgress: true,
    progressText: '{{current}} of {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    showButtons: ['next', 'previous', 'close'],
    allowClose: true,
    // The spotlight hugs the target: 4px of air and the same 6px corner the
    // sidebar's own rows use, so the highlight looks like part of the app.
    stagePadding: 4,
    stageRadius: 6,
    popoverClass: TOUR_POPOVER_CLASS,
    // A stop whose target is not on the page is skipped, never a dead end: the
    // nav is filtered per account (operator-only items), and a tour that hangs
    // waiting for an element that will never exist is the worst failure this
    // feature could have.
    skipMissingElement: true,
    onDestroyed: exit,
  }).drive();
}
