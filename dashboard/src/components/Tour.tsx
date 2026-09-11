import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchMe, type Me } from '../lib/api';
import { TOUR_MIN_VIEWPORT_WIDTH, TOUR_START_DELAY_MS, startTour } from '../lib/tour';

/**
 * U5 — WHEN the first-run tour runs. Renders nothing; the Shell mounts it once
 * and it either starts a tour or it doesn't.
 *
 * Three conditions, all of them cheap:
 *
 *   1. The server says this account still owes one (`tourPending` on /auth/me,
 *      read off the SAME ['me'] query the Shell already keeps warm — the tour
 *      costs no request of its own).
 *   2. The viewport is wide enough for the sidebar every stop points at. A
 *      narrower window skips WITHOUT clearing the flag, so the same person
 *      still gets their tour the first time they open the dashboard on a
 *      desktop.
 *   3. The shell has actually painted — a short delay, because a spotlight that
 *      lands on a nav item mid-mount measures the wrong box.
 */
export default function FirstRunTour() {
  const queryClient = useQueryClient();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: fetchMe, retry: false });
  const tourPending = me?.tourPending === true;

  /**
   * The latch. StrictMode runs every mount effect twice in dev, and ['me']
   * refetches on focus and after any invalidation — without this, a person who
   * alt-tabs away mid-tour comes back to a second driver stacked on the first.
   * A ref, not state: it must already be set when the second effect runs, which
   * a setState scheduled in the first one would not be (the S1.6 `redeeming`
   * idiom, same reason).
   */
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !tourPending) return;
    if (window.innerWidth < TOUR_MIN_VIEWPORT_WIDTH) return;
    started.current = true;

    /**
     * Deliberately NOT cleared on unmount. Under StrictMode the cleanup would
     * cancel the only timer this component will ever schedule (the second
     * effect run finds the latch set and returns), and the tour would never
     * appear in dev — the exact class of bug the latch exists to prevent,
     * inverted. What a cleanup would have protected against is covered inside
     * the callback instead: if the shell is gone by the time it fires, its
     * targets are gone with it, and there is nothing to tour.
     */
    setTimeout(() => {
      if (!document.querySelector('[data-tour="env"]')) return;
      startTour({
        onExit: () => {
          // Belt to the server's braces: POST /auth/tour-done has already been
          // fired (unawaited) by startTour, and this patches the cached answer
          // so an in-flight refetch that crosses the write cannot hand this
          // component a stale `tourPending: true`.
          queryClient.setQueryData(['me'], (prev: Me | undefined) =>
            prev ? { ...prev, tourPending: false } : prev,
          );
        },
      });
    }, TOUR_START_DELAY_MS);
  }, [tourPending, queryClient]);

  return null;
}
