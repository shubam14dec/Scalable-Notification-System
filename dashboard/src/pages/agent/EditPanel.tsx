// The agent form (shared by the list's create modal and the detail page's
// config tabs) plus ConfigPanel — the detail page's config panel, which wires
// the PATCH save and the agent-level Rotate secret button (next to Save, per
// the V1 mockup). API paths and react-query keys identical to the former
// Agents.tsx.
//
// ONE FORM, FOUR TABS. The detail page reads as Edit / Guardrails / Cost &
// routing / Memory, but there is still exactly one <form>, one piece of state,
// one FormData and one save behind all four. Each tab passes `section`; the
// groups below hide rather than unmount, so a half-typed guardrail survives a
// trip to the Cost tab and every field is still in the FormData the save
// reads, whichever tab Save was pressed on. The create modal passes no
// `section` at all and therefore renders the whole form, exactly as before.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, Field, Input, Mono } from '../../ui';
import { timeAgo } from '../Activity';
import { SecretReveal, Toggle, useEvalRuns } from './shared';
import { PreSaveCheck } from './PreSaveCheck';
import {
  baselineRun,
  fmtInt,
  formatEntryList,
  parseEntryList,
  routingSummary,
  runAdvisory,
  runSummary,
  TEXTAREA_CLS,
  type Agent,
  type AgentBody,
  type AgentEval,
  type AgentHealth,
  type AgentModeration,
  type AgentRouting,
  type AgentRoutingStats,
  type AgentSubscriberRate,
  type AgentTopics,
  type EvalCandidate,
  type SuggestedPrompt,
} from './types';

/** The config tabs the one form is split across on the detail page. */
export type ConfigSection = 'edit' | 'guardrails' | 'cost' | 'memory';

/**
 * Which tab owns each named field. Used only to route a validation failure to
 * the tab that can show it (see `onInvalid` on the form) — the save itself
 * never consults this, because the save reads every field regardless of tab.
 */
const FIELD_SECTION: Record<string, ConfigSection> = {
  identifier: 'edit',
  name: 'edit',
  bridgeUrl: 'edit',
  systemPrompt: 'edit',
  model: 'edit',
  llmApiKey: 'edit',
  llmBaseUrl: 'edit',
  maxTokens: 'edit',
  description: 'edit',
  maxDailyTokens: 'cost',
  cheapModel: 'cost',
  topicDeny: 'guardrails',
  topicAllow: 'guardrails',
  topicRedirect: 'guardrails',
  denyPhrases: 'guardrails',
  replyFallback: 'guardrails',
  rateMaxMessages: 'guardrails',
  rateWindowMinutes: 'guardrails',
  rateNotice: 'guardrails',
  autoResolveH: 'guardrails',
  autoResolveM: 'guardrails',
  triggerTurns: 'memory',
  tailTurns: 'memory',
};

/**
 * A group of fields belonging to one config tab. HIDDEN, never unmounted:
 * unmounting would throw away a half-typed policy on every tab switch and —
 * worse — drop those fields out of the FormData the save reads, so pressing
 * Save on the Edit tab would silently clear the guardrails. `active` is
 * undefined in the create modal, where every group shows at once.
 */
function ConfigGroup({
  section,
  active,
  children,
}: {
  section: ConfigSection;
  active?: ConfigSection;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4" hidden={active !== undefined && active !== section}>
      {children}
    </div>
  );
}

export function AgentForm({
  initial,
  pending,
  error,
  submitLabel,
  onSubmit,
  onCancel,
  hideCancel = false,
  footerExtra,
  section,
  onRequestSection,
}: {
  initial?: Partial<Agent>;
  pending: boolean;
  error: string;
  submitLabel: string;
  onSubmit: (body: AgentBody) => void;
  onCancel: () => void;
  hideCancel?: boolean;
  footerExtra?: ReactNode;
  /** Tab currently on screen; omit (the create modal) to show every group. */
  section?: ConfigSection;
  /** Ask the page to switch tabs — used to surface an off-screen field error. */
  onRequestSection?: (section: ConfigSection) => void;
}) {
  const [runtime, setRuntime] = useState<'bridge' | 'managed'>(initial?.runtime ?? 'bridge');
  const editing = Boolean(initial?.identifier);
  const identifier = initial?.identifier ?? '';
  const queryClient = useQueryClient();

  // Agent-speaks-first config: controlled so the char counters and add/remove
  // rows stay live. Empty here means "clear" (sent as null on save).
  const [welcome, setWelcome] = useState(initial?.welcomeMessage ?? '');
  const [prompts, setPrompts] = useState<SuggestedPrompt[]>(initial?.suggestedPrompts ?? []);

  // Advisory eval gate — only meaningful for an existing managed agent whose
  // prompt we're editing. Polls while a run is in flight.
  const evalGateOn = editing && runtime === 'managed' && Boolean(identifier);
  const runsQuery = useEvalRuns(identifier, evalGateOn);
  const latestRun = evalGateOn ? runsQuery.data?.runs?.[0] ?? null : null;
  const runEvals = useMutation({
    mutationFn: () => api(`/v1/agents/${identifier}/evals/run`, { method: 'POST' }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['agent-eval-runs', identifier] }),
  });
  // A4: the pre-save check. It needs the agent's enabled evals (same query key
  // the Evals tab uses, so visiting both costs one fetch) and a baseline — the
  // newest finished run of the SAVED config, which the advisory query already
  // has in hand. Nothing here touches the save path itself.
  const evalsQuery = useQuery({
    queryKey: ['agent-evals', identifier],
    queryFn: () => api<{ evals: AgentEval[] }>(`/v1/agents/${identifier}/evals`),
    enabled: evalGateOn,
  });
  const enabledEvals = evalsQuery.data?.evals.filter((e) => e.enabled).length ?? 0;
  const preSaveOn = evalGateOn && enabledEvals > 0;
  const [pendingSave, setPendingSave] = useState<{
    body: AgentBody;
    candidate: EvalCandidate;
  } | null>(null);

  const advisory = latestRun ? runAdvisory(latestRun, timeAgo) : null;
  const advisoryDot = !latestRun
    ? 'var(--t3)'
    : latestRun.status === 'running'
      ? 'var(--info)'
      : advisory!.ok
        ? 'var(--ok)'
        : 'var(--err)';

  // Budget suggestion (Phase 24 D10) — the health window carries 30-day p95
  // daily usage + a suggested budget once ≥7 days of data exist. Only fetched
  // for an existing managed agent; guarded so it stays silent until slice C
  // populates the fields.
  const budgetHintOn = editing && runtime === 'managed' && Boolean(identifier);
  const healthQuery = useQuery({
    queryKey: ['agent-health', identifier, 30],
    queryFn: () => api<AgentHealth>(`/v1/agents/${identifier}/health?days=30`),
    enabled: budgetHintOn,
  });
  const suggested = healthQuery.data?.suggestedDailyTokens;
  const p95Daily = healthQuery.data?.p95DailyTokens;

  // ---- A6: model routing ----
  // The switch is state (the section's copy and the stats strip react to it);
  // the cheap-model id is an ordinary uncontrolled field like Model, read off
  // the form on submit. Switching the router off does NOT wipe the id — it
  // rides along as `enabled: false`, so turning it back on costs no retyping.
  const [routingOn, setRoutingOn] = useState(initial?.routing?.enabled ?? false);
  const routingStats = useQuery({
    queryKey: ['agent-routing-stats', identifier],
    queryFn: () => api<AgentRoutingStats>(`/v1/agents/${identifier}/routing/stats`),
    // Only asked for once the agent EXISTS, is managed, and is actually routing:
    // the numbers describe live traffic, and there is none to describe otherwise.
    enabled: editing && runtime === 'managed' && Boolean(identifier) && routingOn,
  });
  const routingWords = routingStats.data ? routingSummary(routingStats.data) : null;

  /** The routing config this form would save, or null for "off and forgotten". */
  const readRouting = (cheapModel: string): AgentRouting | null =>
    routingOn || cheapModel ? { enabled: routingOn, cheapModel } : null;

  // ---- A7: the two gates ----
  // Controlled, unlike the routing id: each list box drives its own live entry
  // count, and the redirect/fallback fields become REQUIRED the moment their
  // gate has something to match on — a policy that blocks with nothing to say
  // is a mute button, and the form refuses to save one.
  const [topicDeny, setTopicDeny] = useState(formatEntryList(initial?.topics?.deny));
  const [topicAllow, setTopicAllow] = useState(formatEntryList(initial?.topics?.allow));
  const [topicRedirect, setTopicRedirect] = useState(initial?.topics?.redirect ?? '');
  const [denyPhrases, setDenyPhrases] = useState(
    formatEntryList(initial?.moderation?.denyPhrases),
  );
  const [blockPii, setBlockPii] = useState(initial?.moderation?.blockPii ?? false);
  const [replyFallback, setReplyFallback] = useState(initial?.moderation?.fallback ?? '');

  const denyLabels = parseEntryList(topicDeny);
  const allowLabels = parseEntryList(topicAllow);
  const phraseList = parseEntryList(denyPhrases);
  /** A gate with nothing to match on isn't configured, however much text is around it. */
  const topicsArmed = denyLabels.length > 0 || allowLabels.length > 0;
  const rulesArmed = phraseList.length > 0 || blockPii;

  /** The topic policy this form would save, or null for "off and forgotten". */
  const readTopics = (): AgentTopics | null =>
    topicsArmed && topicRedirect.trim()
      ? {
          ...(denyLabels.length ? { deny: denyLabels } : {}),
          ...(allowLabels.length ? { allow: allowLabels } : {}),
          redirect: topicRedirect.trim(),
        }
      : null;

  /** The reply rules this form would save, or null for "off and forgotten". */
  const readModeration = (): AgentModeration | null =>
    rulesArmed && replyFallback.trim()
      ? {
          ...(phraseList.length ? { denyPhrases: phraseList } : {}),
          ...(blockPii ? { blockPii: true } : {}),
          fallback: replyFallback.trim(),
        }
      : null;

  // The one save this form refuses outright. `required` on the boxes catches an
  // EMPTY redirect/fallback, but not a whitespace-only one — and that save is
  // the dangerous shape: both gates trim, so a lone space reads as "no reply to
  // send", the policy stops applying, and the operator would watch a boundary
  // they still see on screen quietly stop existing. Stated in words next to the
  // field rather than as a blocked button with no reason.
  const topicsIncomplete = runtime === 'managed' && topicsArmed && !topicRedirect.trim();
  const rulesIncomplete = runtime === 'managed' && rulesArmed && !replyFallback.trim();

  // ---- A8: per-customer message limits ----
  // Controlled for the same reason the gates are: the notice becomes REQUIRED
  // the moment there are numbers, and the numbers have to be readable while the
  // operator types to know that. NOT gated on runtime anywhere below — this is
  // ingress protection, and a bridge agent's own handler is just as floodable.
  // The bounds on the inputs are a HAND-KEPT COPY of the constants in
  // src/core/subscriber-rate.ts (MAX_MESSAGES_MIN/MAX, WINDOW_MINUTES_MIN/MAX,
  // NOTICE_MAX) — this app builds standalone and cannot import server code. They
  // are hints, not the law: the API validates against the core constants
  // themselves, and a number past them is refused there rather than clamped.
  const [rateMax, setRateMax] = useState(
    initial?.subscriberRate ? String(initial.subscriberRate.maxMessages) : '',
  );
  const [rateWindow, setRateWindow] = useState(
    initial?.subscriberRate ? String(initial.subscriberRate.windowMinutes) : '',
  );
  const [rateNotice, setRateNotice] = useState(initial?.subscriberRate?.notice ?? '');

  const rateMaxNum = Number.parseInt(rateMax, 10);
  const rateWindowNum = Number.parseInt(rateWindow, 10);
  /** A limit needs BOTH numbers: a cap with no window is not a rate, and a window with no cap is not a limit. */
  const rateArmed =
    Number.isFinite(rateMaxNum) && rateMaxNum > 0 && Number.isFinite(rateWindowNum) && rateWindowNum > 0;
  /** Anything typed in the card at all — the test for "did the operator mean to configure this?". */
  const rateTouched = Boolean(rateMax.trim() || rateWindow.trim() || rateNotice.trim());

  /** The message limit this form would save, or null for "off and forgotten". */
  const readSubscriberRate = (): AgentSubscriberRate | null =>
    rateArmed && rateNotice.trim()
      ? { maxMessages: rateMaxNum, windowMinutes: rateWindowNum, notice: rateNotice.trim() }
      : null;

  /**
   * The half-filled card, refused in words rather than as a dead button. Two
   * shapes land here and both are the same failure: one number without the
   * other, and a notice that is empty or only spaces. The second is the A7
   * lesson repeated — the server trims the notice and an empty one reads as NO
   * LIMIT, so a lone space would leave a limit the operator can still see on
   * screen quietly not existing.
   */
  const rateIncomplete = rateTouched && (!rateArmed || !rateNotice.trim());

  // Field-by-field rather than JSON.stringify: key ORDER would make a
  // re-typed-identical policy look like an edit and put the operator through a
  // check that grades nothing new.
  const sameTopics = (a: AgentTopics | null, b: AgentTopics | null) =>
    (a?.deny ?? []).join(',') === (b?.deny ?? []).join(',') &&
    (a?.allow ?? []).join(',') === (b?.allow ?? []).join(',') &&
    (a?.redirect ?? '') === (b?.redirect ?? '');
  const sameModeration = (a: AgentModeration | null, b: AgentModeration | null) =>
    (a?.denyPhrases ?? []).join(',') === (b?.denyPhrases ?? []).join(',') &&
    (a?.blockPii ?? false) === (b?.blockPii ?? false) &&
    (a?.fallback ?? '') === (b?.fallback ?? '');

  // Cross-tab validation. A `required` field on a tab that is not on screen
  // cannot be focused, so the browser refuses the submit with no message at
  // all — the operator would press Save and watch nothing happen, which is the
  // one failure mode splitting the form could have introduced. So: catch the
  // invalid event (React attaches one to every input/select/textarea and
  // dispatches it up the tree), suppress the bubble nobody could see, switch to
  // the tab that owns the field, and re-report it once it is visible — the
  // native message then lands exactly where it always did. Re-reporting fires
  // `invalid` again, but by then the field is on the active tab, so the handler
  // below leaves it alone and the browser takes over.
  const [offscreenInvalid, setOffscreenInvalid] = useState<HTMLInputElement | null>(null);

  // The styled replacement for the browser's validation bubble (his call:
  // the stock "Please fill out this field" chrome clashes with the design
  // system). The VALIDATION is still the browser's — required/pattern fire
  // exactly as before and still block the submit — only the presentation is
  // ours: the form suppresses every native bubble via preventDefault in
  // `onInvalid` and re-lands the message in this tip, anchored under the
  // field in the dashboard's own chrome.
  const [invalidTip, setInvalidTip] = useState<{
    el: HTMLInputElement;
    message: string;
    x: number;
    y: number;
    side: 'right' | 'below';
  } | null>(null);
  // The browser reports only the FIRST invalid control of a submit; with the
  // bubble suppressed, `invalid` fires for every one, so mimic that: take the
  // first, ignore the rest of the same synchronous batch.
  const invalidHandled = useRef(false);

  /** Centre the field, focus it, and open the tip against its settled rect. */
  const surfaceInvalid = useCallback((el: HTMLInputElement) => {
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
    const rect = el.getBoundingClientRect();
    // Beside the field, not under it (his call — cleaner): vertically centred
    // to the right, gap of 8. Only when the viewport truly has room for the
    // tip's max width there; a narrow window falls back to the old
    // below-the-field spot rather than covering the input or the edge.
    const fitsRight = window.innerWidth - rect.right >= 328;
    setInvalidTip({
      el,
      // Errors say what happened and what to do (design system) — the stock
      // wording says neither. Non-required failures (pattern etc.) keep the
      // browser's specific message, just in our chrome.
      message: el.validity.valueMissing
        ? 'Required — fill this in before saving.'
        : el.validationMessage,
      x: fitsRight ? rect.right + 8 : Math.max(8, Math.min(rect.left, window.innerWidth - 328)),
      y: fitsRight ? rect.top + rect.height / 2 : rect.bottom + 6,
      side: fitsRight ? 'right' : 'below',
    });
  }, []);

  useEffect(() => {
    if (!offscreenInvalid) return;
    // Wait for the CAUSE, not a frame count. The tab switch rides
    // `onRequestSection` → the page's setSearchParams → React Router, which
    // wraps navigations in a transition — the commit that removes `hidden`
    // from the owning group can land after any fixed number of frames, and
    // scrolling an element with no layout box is a silent no-op (which is
    // exactly how the first two attempts died). So the effect keys on
    // `section` too and acts only once it has become the field's owner: by
    // the time this effect runs, React has committed the un-hide, so the
    // field is on screen and has real geometry. One frame after that lets
    // the expanded sections settle, then surface the tip.
    if (section !== undefined && section !== FIELD_SECTION[offscreenInvalid.name]) return;
    const el = offscreenInvalid;
    const frame = requestAnimationFrame(() => {
      setOffscreenInvalid(null);
      surfaceInvalid(el);
    });
    return () => cancelAnimationFrame(frame);
  }, [offscreenInvalid, section, surfaceInvalid]);

  // Dismissal, matching the native bubble's manners: typing in the field,
  // clicking anywhere, leaving the field, or a few idle seconds all clear it.
  // The scroll listener arms one frame late — surfaceInvalid's own
  // scrollIntoView delivers its scroll event asynchronously, and catching our
  // own scroll would dismiss the tip before it was ever seen.
  useEffect(() => {
    if (!invalidTip) return;
    const clear = () => setInvalidTip(null);
    const { el } = invalidTip;
    el.addEventListener('input', clear);
    el.addEventListener('blur', clear);
    document.addEventListener('pointerdown', clear);
    const frame = requestAnimationFrame(() => {
      window.addEventListener('scroll', clear, true);
    });
    const timer = window.setTimeout(clear, 6000);
    return () => {
      el.removeEventListener('input', clear);
      el.removeEventListener('blur', clear);
      document.removeEventListener('pointerdown', clear);
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', clear, true);
      window.clearTimeout(timer);
    };
  }, [invalidTip]);

  return (
    <>
    <form
      className="space-y-4"
      onInvalid={(e) => {
        // Every native bubble is suppressed — the message re-lands in the
        // styled tip instead. An off-tab field first asks the page to switch
        // (the section-keyed effect above finishes the job once the switch
        // commits); an on-screen one is surfaced right here.
        e.preventDefault();
        if (invalidHandled.current) return;
        invalidHandled.current = true;
        queueMicrotask(() => {
          invalidHandled.current = false;
        });
        const el = e.target as HTMLInputElement;
        const owner = FIELD_SECTION[el.name];
        if (section && owner && owner !== section) {
          onRequestSection?.(owner);
          setOffscreenInvalid(el);
        } else {
          surfaceInvalid(el);
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        // A7: a gate with rules but nothing to say is never saved, in either
        // direction — it would neither block nor keep blocking.
        // A8: same rule for a half-filled message limit, on either runtime.
        if (topicsIncomplete || rulesIncomplete || rateIncomplete) return;
        const form = new FormData(e.currentTarget);
        const str = (key: string) => String(form.get(key) ?? '').trim();
        const body: AgentBody = {
          identifier: str('identifier') || initial?.identifier || '',
          name: str('name'),
          description: str('description') || undefined,
          runtime,
        };
        if (runtime === 'bridge') {
          body.bridgeUrl = str('bridgeUrl');
        } else {
          body.model = str('model') || undefined;
          body.systemPrompt = str('systemPrompt') || undefined;
          const maxTokens = Number.parseInt(str('maxTokens'), 10);
          if (Number.isFinite(maxTokens)) body.maxTokens = maxTokens;
          const apiKey = str('llmApiKey');
          const baseUrl = str('llmBaseUrl');
          // On edit, a blank key means "keep the stored one".
          if (apiKey || baseUrl || !editing) {
            body.llm = {
              ...(apiKey ? { apiKey } : {}),
              ...(baseUrl ? { baseUrl } : {}),
            };
          }
          // Daily token budget (G2): blank = off; clearing an existing one → null.
          const maxDaily = Number.parseInt(str('maxDailyTokens'), 10);
          if (Number.isFinite(maxDaily) && maxDaily > 0) {
            body.maxDailyTokens = maxDaily;
          } else if (editing && initial?.maxDailyTokens != null) {
            body.maxDailyTokens = null;
          }
          // Rolling-summary knobs (D6): only sent when at least one is set.
          const triggerTurns = Number.parseInt(str('triggerTurns'), 10);
          const tailTurns = Number.parseInt(str('tailTurns'), 10);
          const context: { triggerTurns?: number; tailTurns?: number } = {};
          if (Number.isFinite(triggerTurns) && triggerTurns > 0) context.triggerTurns = triggerTurns;
          if (Number.isFinite(tailTurns) && tailTurns > 0) context.tailTurns = tailTurns;
          if (Object.keys(context).length > 0) body.context = context;
          // A6 routing: same rule maxDailyTokens follows — send the config when
          // there is one, send an explicit null only on an EDIT (create has
          // nothing to clear, and its schema rejects null), send nothing at all
          // for a brand-new agent that never touched the switch.
          const nextRouting = readRouting(str('cheapModel'));
          if (nextRouting) {
            body.routing = nextRouting;
          } else if (editing && initial?.routing) {
            body.routing = null;
          }
          // A7: the two gates follow the identical rule. Emptying the last deny
          // label of a configured gate is how you switch it OFF, and that has to
          // reach the server as an explicit null — otherwise the boundary the
          // operator just deleted stays in force on every message.
          const nextTopics = readTopics();
          if (nextTopics) {
            body.topics = nextTopics;
          } else if (editing && initial?.topics) {
            body.topics = null;
          }
          const nextModeration = readModeration();
          if (nextModeration) {
            body.moderation = nextModeration;
          } else if (editing && initial?.moderation) {
            body.moderation = null;
          }
        }
        // A8: OUTSIDE the runtime branch above, because the message limit is the
        // one config a bridge agent may hold. Otherwise the identical rule the
        // gates follow — clearing the numbers is how you switch it off, and that
        // has to reach the server as an explicit null or the limit the operator
        // just deleted stays in force on every message.
        const nextRate = readSubscriberRate();
        if (nextRate) {
          body.subscriberRate = nextRate;
        } else if (editing && initial?.subscriberRate) {
          body.subscriberRate = null;
        }
        const arHours = Number.parseInt(str('autoResolveH'), 10);
        const arMins = Number.parseInt(str('autoResolveM'), 10);
        const totalMinutes =
          (Number.isFinite(arHours) ? arHours * 60 : 0) + (Number.isFinite(arMins) ? arMins : 0);
        if (totalMinutes > 0) {
          body.autoResolveMinutes = totalMinutes;
        } else if (editing && initial?.autoResolveMinutes) {
          body.autoResolveMinutes = null; // both cleared = backstop off
        }
        // Welcome + prompts always travel (null clears) so an emptied field saves.
        body.welcomeMessage = welcome.trim() ? welcome.trim() : null;
        const cleanPrompts = prompts
          .map((p) => ({ title: p.title.trim(), message: p.message.trim() }))
          .filter((p) => p.title && p.message)
          .slice(0, 6);
        body.suggestedPrompts = cleanPrompts.length ? cleanPrompts : null;

        // A4 PRE-SAVE CHECK — a managed agent with enabled evals whose PROMPT,
        // MODEL or (A6) MODEL ROUTING actually changed gets those evals run
        // against the EDITED values before the save commits. The panel owns the
        // rest of this save: it calls back with `body` untouched (Save / Save
        // anyway) or drops it (Cancel). Supersedes the confirm() advisory below
        // for this one case — two warnings about the same edit is one too many.
        // Every other save (bridge, no enabled evals, nothing behavioral
        // changed) falls through to the pre-A4 path below, byte for byte.
        if (preSaveOn) {
          const nextPrompt = str('systemPrompt');
          const nextModel = str('model');
          const candidate: EvalCandidate = {};
          // Only CHANGED keys ride along, and only non-empty ones: the server
          // caps a candidate field at 1..N, so "cleared to blank" is not an
          // override to grade — that save takes the normal path.
          if (nextPrompt && nextPrompt !== (initial?.systemPrompt ?? '').trim()) {
            candidate.systemPrompt = nextPrompt;
          }
          if (nextModel && nextModel !== (initial?.model ?? '').trim()) {
            candidate.model = nextModel;
          }
          // A6: enabling the router, disabling it, or swapping the cheap model
          // all change which model writes the reply — a behavior change exactly
          // like a prompt edit, so it rides the SAME candidate the check grades
          // and the run really executes through the edited router. Sent even
          // when the new value is "off" (an explicit null), because "does it
          // still pass with routing off?" is a real question to ask of a save
          // that switches routing off.
          const nextRouting = readRouting(str('cheapModel'));
          const prev = initial?.routing ?? null;
          const changed =
            (prev?.enabled ?? false) !== (nextRouting?.enabled ?? false) ||
            (prev?.cheapModel ?? '') !== (nextRouting?.cheapModel ?? '');
          if (changed) candidate.routing = nextRouting;
          // A7: a gate edit is a behavior change of the bluntest kind — it
          // decides whether a message is answered at all, and what ships when it
          // is not. So it rides the same candidate, and the run really executes
          // behind the edited gate: an eval whose message the NEW deny list
          // catches meets the redirect, exactly as a customer would. Sent even
          // when the new value is "off" (an explicit null), because "do the
          // evals still pass without this boundary?" is the whole question a
          // save that removes one is asking.
          const nextTopics = readTopics();
          if (!sameTopics(nextTopics, initial?.topics ?? null)) candidate.topics = nextTopics;
          const nextModeration = readModeration();
          if (!sameModeration(nextModeration, initial?.moderation ?? null)) {
            candidate.moderation = nextModeration;
          }
          // A8: the message limit is DELIBERATELY ABSENT from this candidate,
          // and a save that changes only the limit therefore never opens the
          // check. The gates change what the agent SAYS, so an edit to one must
          // be graded or the check grades an agent that does not exist; a
          // message limit changes whether a FLOOD is answered, and every eval
          // scenario is a burst of messages from one synthetic subscriber by
          // construction — a gradeable limit would throttle the check itself and
          // report the limiter's behavior as the prompt's. There is no candidate
          // field to send it in (see CandidateSchema in api/routes/agent-evals.ts).
          if (
            candidate.systemPrompt !== undefined ||
            candidate.model !== undefined ||
            'routing' in candidate ||
            'topics' in candidate ||
            'moderation' in candidate
          ) {
            setPendingSave({ body, candidate });
            return;
          }
        }

        // Advisory eval gate (never a hard block): if the latest run failed, or
        // the prompt changed since it ran (so the run tested a different
        // version), ask once before saving.
        if (evalGateOn && latestRun && latestRun.status !== 'running') {
          const currentPrompt = str('systemPrompt');
          const promptDirty = (initial?.systemPrompt ?? '').trim() !== currentPrompt;
          const s = runSummary(latestRun);
          const hasFailures =
            latestRun.status === 'failed' || latestRun.status === 'error' || s.failed > 0;
          const runPredatesSave =
            !!initial?.updatedAt &&
            !!latestRun.finishedAt &&
            new Date(latestRun.finishedAt).getTime() < new Date(initial.updatedAt).getTime();
          if (
            (hasFailures || promptDirty || runPredatesSave) &&
            !window.confirm("Evals haven't passed for this version — save anyway?")
          ) {
            return;
          }
        }
        onSubmit(body);
      }}
    >
      <ConfigGroup section="edit" active={section}>
        {!editing && (
          <Field label="Identifier" hint="Stable id used by the widget and SDK — cannot change later">
            <Input name="identifier" required autoFocus placeholder="support" className="font-mono" pattern="[a-z0-9-_]+" />
          </Field>
        )}
        <Field label="Name">
          <Input name="name" required placeholder="Support agent" defaultValue={initial?.name} />
        </Field>

        <Field label="Runtime" hint="Who answers each message">
          <select
            aria-label="Runtime"
            className="h-8 w-full rounded-md border border-bd bg-transparent px-2 text-[13px] text-t1 hover:border-bd-strong"
            value={runtime}
            onChange={(e) => setRuntime(e.target.value as 'bridge' | 'managed')}
          >
            <option value="bridge" className="bg-surface">Your code — we POST turns to your bridge URL</option>
            <option value="managed" className="bg-surface">Managed LLM — we run the model, zero code</option>
          </select>
        </Field>
      </ConfigGroup>

      {runtime === 'bridge' ? (
        <ConfigGroup section="edit" active={section}>
          <Field label="Bridge URL" hint="Where your handler listens — we POST every conversation turn here, signed">
            <Input
              name="bridgeUrl"
              required
              type="url"
              placeholder="https://app.example.com/asyncify-agent"
              defaultValue={initial?.bridgeUrl ?? ''}
              className="font-mono"
            />
          </Field>
        </ConfigGroup>
      ) : (
        <>
          {/* Identity and the model connection — the Edit tab. Max reply tokens
              follows Base URL here rather than Model, so the whole LLM
              connection reads as one run of fields once the spend knobs have
              moved to Cost & routing. */}
          <ConfigGroup section="edit" active={section}>
            <Field label="System prompt" hint="The agent's role, tone, and boundaries — runs on every turn">
              <textarea
                name="systemPrompt"
                rows={5}
                placeholder="You are the Acme support agent. Be brief and friendly…"
                defaultValue={initial?.systemPrompt ?? ''}
                className="w-full rounded-md border border-bd bg-transparent px-2.5 py-2 text-[13px] text-t1 placeholder:text-t3 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong"
              />
            </Field>
            <Field label="Model" hint="Defaults to claude-opus-4-8; use your endpoint's model id if you set a base URL">
              <Input name="model" placeholder="claude-opus-4-8" defaultValue={initial?.model ?? ''} className="font-mono" />
            </Field>
            <Field
              label="API key"
              hint={
                initial?.hasLlmKey
                  ? 'A key is stored — leave blank to keep it, paste to replace'
                  : 'Stored encrypted, never shown again'
              }
            >
              <Input
                name="llmApiKey"
                type="password"
                autoComplete="off"
                required={runtime === 'managed' && !initial?.hasLlmKey}
                placeholder={initial?.hasLlmKey ? '••••••••  (kept)' : 'sk-ant-… or your provider key'}
                className="font-mono"
              />
            </Field>
            <Field
              label="Base URL"
              hint="Optional — any Anthropic-compatible endpoint (e.g. z.ai). Blank = api.anthropic.com"
            >
              <Input
                name="llmBaseUrl"
                type="url"
                placeholder="https://api.z.ai/api/anthropic"
                defaultValue={initial?.llmBaseUrl ?? ''}
                className="font-mono"
              />
            </Field>
            <Field label="Max reply tokens" hint="Per-reply output cap, 256–8192 (blank = 1024). Controls spend on your key">
              <Input
                name="maxTokens"
                type="number"
                min={256}
                max={8192}
                placeholder="1024"
                defaultValue={initial?.maxTokens ?? ''}
                className="font-mono"
              />
            </Field>
          </ConfigGroup>

          {/* Cost & routing — the two knobs that decide what a day of this
              agent costs: the ceiling, and which model writes the easy half of
              the replies. */}
          <ConfigGroup section="cost" active={section}>
            <Field
              label="Daily token budget"
              hint="Circuit breaker, not a quota — size it ~4x a busy day (see Health for tokens/turn)."
            >
              <Input
                name="maxDailyTokens"
                type="number"
                min={1}
                placeholder="off"
                defaultValue={initial?.maxDailyTokens ?? ''}
                className="font-mono"
              />
            </Field>
            {budgetHintOn && suggested != null && (
              <p className="-mt-2 text-[11px] text-t3">
                30-day p95 daily usage:{' '}
                <Mono className="text-t2">{fmtInt(p95Daily)}</Mono> · suggested budget:{' '}
                <Mono className="text-t2">{fmtInt(suggested)}</Mono>
              </p>
            )}

            {/* Phase A6 — model routing. Managed only: it lives inside this
                branch, so a bridge agent never sees the section at all. */}
            <div className="space-y-3 rounded-md border border-bd bg-elevated px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="block text-[12px] font-medium text-t2">Model routing</span>
                  <span className="mt-0.5 block text-[11px] text-t3">
                    Answer the easy messages on a cheaper model. Simple replies are handled by the
                    smaller model; anything that needs a real action — a refund, a workflow, a
                    knowledge lookup — automatically runs on your main model instead.
                  </span>
                </div>
                <Toggle checked={routingOn} onChange={setRoutingOn} label="Model routing enabled" />
              </div>
              <Field
                label="Cheap model"
                hint="Must be a model your LLM endpoint already serves — routing uses this agent's own key and base URL. Getting the id wrong is safe: every reply just runs on the main model."
              >
                <Input
                  name="cheapModel"
                  required={routingOn}
                  placeholder="claude-haiku-4-5"
                  defaultValue={initial?.routing?.cheapModel ?? ''}
                  className="font-mono"
                />
              </Field>
              {/* The stats strip — what routing actually did, in words. */}
              {routingOn && editing && routingStats.isSuccess && (
                <div className="space-y-1 border-t border-bd pt-3">
                  {routingWords ? (
                    <>
                      <p className="text-[11px] text-t3">
                        Last {routingStats.data.windowDays} days ·{' '}
                        <Mono className="text-t3">{fmtInt(routingStats.data.replies)}</Mono> replies
                      </p>
                      {/* The headline figures — large numbers, quiet words (his
                          feedback: these ARE the feature's payoff; 11px prose
                          buried them). Same figure idiom as the health stats. */}
                      <div className="flex gap-6 pt-1">
                        <div>
                          <Mono className="block text-[20px] leading-tight text-t1">
                            {routingWords.cheap.pct}%
                          </Mono>
                          <span className="mt-0.5 block max-w-[180px] text-[11px] leading-snug text-t2">
                            {routingWords.cheap.label}
                          </span>
                        </div>
                        <div>
                          <Mono className="block text-[20px] leading-tight text-t1">
                            {routingWords.escalated.pct}%
                          </Mono>
                          <span className="mt-0.5 block max-w-[180px] text-[11px] leading-snug text-t2">
                            {routingWords.escalated.label}
                          </span>
                        </div>
                      </div>
                      {routingWords.unrouted && (
                        <p className="pt-1 text-[11px] text-t3">{routingWords.unrouted}</p>
                      )}
                    </>
                  ) : (
                    <p className="text-[11px] text-t3">
                      No routed replies in the last {routingStats.data.windowDays} days.
                    </p>
                  )}
                  <p className="text-[11px] text-t3">
                    Canary-trial replies always use the trial's own model, so they're not counted
                    here.
                  </p>
                </div>
              )}
            </div>
          </ConfigGroup>

          {/* Guardrails — what the agent will not talk about, what it may not
              say, and how hard one customer may push it. The two cards below
              are managed-only (they shape what the model writes); the message
              limit further down applies to both runtimes. */}
          <ConfigGroup section="guardrails" active={section}>
            {/* Phase A7 — the topic gate. Managed only, like routing above: it
                lives inside this branch, so a bridge agent never sees it. */}
            <div className="space-y-3 rounded-md border border-bd bg-elevated px-3 py-3">
              <div>
                <span className="block text-[12px] font-medium text-t2">Topics</span>
                <span className="mt-0.5 block text-[11px] text-t3">
                  Before the agent answers, a small model reads the customer's message and names what
                  it is about; anything you have ruled out gets your reply below instead of a
                  model-written one. That check costs one extra call to the cheap model on every
                  message — the price of not having to trust the prompt alone. Leave both lists empty
                  and nothing changes.
                </span>
              </div>
              <Field
                label="Topics this agent won't discuss"
                hint="One per line, or separated by commas. Plain words — “medical advice”, “competitor pricing”, “legal questions”."
              >
                <textarea
                  name="topicDeny"
                  rows={3}
                  value={topicDeny}
                  onChange={(e) => setTopicDeny(e.target.value)}
                  placeholder={'medical advice\nlegal advice'}
                  className={TEXTAREA_CLS}
                />
              </Field>
              <div className="-mt-2 text-right">
                <Mono className="text-t3">{denyLabels.length} of 24</Mono>
              </div>
              <Field
                label="Only discuss (optional)"
                hint="Leave blank to allow everything except the list above. Fill it in and it becomes the COMPLETE list of what this agent handles — anything else is off-topic. A topic in both lists is blocked: “won't discuss” always wins."
              >
                <textarea
                  name="topicAllow"
                  rows={2}
                  value={topicAllow}
                  onChange={(e) => setTopicAllow(e.target.value)}
                  placeholder={'orders and delivery\nreturns'}
                  className={TEXTAREA_CLS}
                />
              </Field>
              <div className="-mt-2 text-right">
                <Mono className="text-t3">{allowLabels.length} of 24</Mono>
              </div>
              <Field
                label="When asked something else, reply with:"
                hint="Sent word for word, by us — the model never writes a reply on a blocked topic, so there is nothing for it to be talked out of. Required once either list has anything in it."
              >
                <textarea
                  name="topicRedirect"
                  rows={2}
                  required={topicsArmed}
                  maxLength={2000}
                  value={topicRedirect}
                  onChange={(e) => setTopicRedirect(e.target.value.slice(0, 2000))}
                  placeholder="I can only help with orders and returns here — for anything else, email support@acme.com."
                  className={TEXTAREA_CLS}
                />
              </Field>
              {topicsIncomplete && (
                <p className="-mt-2 text-[11px] text-err">
                  Add the reply to send, or clear the lists above — a topic rule with no reply would
                  leave the customer with silence.
                </p>
              )}
            </div>

            {/* Phase A7 slice B — the outbound gate. Managed only, same branch. */}
            <div className="space-y-3 rounded-md border border-bd bg-elevated px-3 py-3">
              <div>
                <span className="block text-[12px] font-medium text-t2">Reply rules</span>
                <span className="mt-0.5 block text-[11px] text-t3">
                  Every reply the agent drafts is checked before it is sent; a reply that breaks a
                  rule never leaves, and the customer gets your fallback below instead. No model, no
                  extra call, no added wait. It matches the words you type, not paraphrases of them —
                  that is the honest limit of a check that costs nothing and can never be down.
                </span>
              </div>
              <Field
                label="Words a reply may never contain"
                hint="One per line, or separated by commas. Matched anywhere inside a word and in any capitalization, so “guarantee” also catches “guaranteed”. Catching too much? Make the phrase MORE SPECIFIC — “a full refund” rather than “refund”. Padding it with spaces will not help: we trim what you type, on purpose, so a stray space can never quietly switch a rule off."
              >
                <textarea
                  name="denyPhrases"
                  rows={3}
                  value={denyPhrases}
                  onChange={(e) => setDenyPhrases(e.target.value)}
                  placeholder={'guarantee\nrisk-free'}
                  className={TEXTAREA_CLS}
                />
              </Field>
              <div className="-mt-2 text-right">
                <Mono className="text-t3">{phraseList.length} of 100</Mono>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="text-[11px] text-t3">
                  Block other people's email addresses and phone numbers — the customer's own are
                  always allowed, so the agent can still confirm the address on their account.
                </span>
                <Toggle
                  checked={blockPii}
                  onChange={setBlockPii}
                  label="Block other people's contact details"
                />
              </div>
              <Field
                label="If a reply is blocked, send instead:"
                hint="Write this carefully: by the time it sends, the turn's work has already happened — a refund may have been issued, a workflow may have fired. “A teammate will follow up shortly” is always true; “I wasn't able to help with that” can be a lie. Required once there is a rule to break."
              >
                <textarea
                  name="replyFallback"
                  rows={2}
                  required={rulesArmed}
                  maxLength={2000}
                  value={replyFallback}
                  onChange={(e) => setReplyFallback(e.target.value.slice(0, 2000))}
                  placeholder="Let me get a teammate to confirm this for you — someone will follow up shortly."
                  className={TEXTAREA_CLS}
                />
              </Field>
              {rulesIncomplete && (
                <p className="-mt-2 text-[11px] text-err">
                  Add the reply to send instead, or clear the rules above — a blocked reply with no
                  replacement would leave the customer with silence.
                </p>
              )}
            </div>
          </ConfigGroup>

          {/* The rolling summary is conversation-memory behavior, so it reads
              on the Memory tab beside the per-customer facts — but it is still
              this form's field and this form's save, not a second one. */}
          <ConfigGroup section="memory" active={section}>
            {/* Phase 24 D6 — rolling-summary knobs. Blank uses the defaults. */}
            <div className="space-y-3 rounded-md border border-bd bg-elevated px-3 py-3">
              <div>
                <span className="block text-[12px] font-medium text-t2">
                  Advanced — long conversations
                </span>
                <span className="mt-0.5 block text-[11px] text-t3">
                  On long chats the agent condenses older turns into a running summary to stay fast and
                  in budget. Blank uses the defaults (summarize after 20 turns, keep the last 10
                  verbatim).
                </span>
              </div>
              <Field
                label="Summarize after N turns"
                hint="Fold older turns into a summary once the conversation passes this many turns."
              >
                <Input
                  name="triggerTurns"
                  type="number"
                  min={1}
                  placeholder="20"
                  defaultValue={initial?.context?.triggerTurns ?? ''}
                  className="font-mono"
                />
              </Field>
              <Field
                label="Keep last N turns verbatim"
                hint="How many recent turns stay word-for-word after a summary is made."
              >
                <Input
                  name="tailTurns"
                  type="number"
                  min={1}
                  placeholder="10"
                  defaultValue={initial?.context?.tailTurns ?? ''}
                  className="font-mono"
                />
              </Field>
            </div>
          </ConfigGroup>
        </>
      )}

      <ConfigGroup section="guardrails" active={section}>
        {/* Phase A8 — per-customer message limits. OUTSIDE the runtime branch
            above on purpose, so it renders for BOTH runtimes: unlike routing and
            the two gates, this is not brain config but ingress protection, and a
            flood costs a bridge agent its own compute and its own bill just as
            surely as it costs a managed agent tokens. For a managed agent it
            follows the Reply rules card; for a bridge agent it is the only card
            on the form. */}
        <div className="space-y-3 rounded-md border border-bd bg-elevated px-3 py-3">
          <div>
            <span className="block text-[12px] font-medium text-t2">Message limits</span>
            <span className="mt-0.5 block text-[11px] text-t3">
              Stops one customer — or a bot — from flooding the agent; everyone else is
              unaffected. Past the limit the agent stops replying to that one person until the
              window ends, and they are told ONCE per window — not on every message, so a flood
              can never be turned into a flood of replies. Their messages still appear in the
              conversation exactly as they were sent: only the reply is withheld, so the record
              of what someone actually sent you stays true. Leave the fields blank and nothing
              changes.
            </span>
          </div>
          <Field
            label="Max messages per customer"
            hint="How many messages ONE customer may send in the window below (1–1000). Taps on the agent's buttons count too — a tap flood is a flood."
          >
            <Input
              name="rateMaxMessages"
              type="number"
              min={1}
              max={1000}
              placeholder="off"
              value={rateMax}
              onChange={(e) => setRateMax(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field
            label="in a window of (minutes)"
            hint="1–1440 (one day). A fixed block, not a rolling one — when the window ends the count starts from zero. Retuning either number starts a fresh count for everyone rather than carrying the old one over."
          >
            <Input
              name="rateWindowMinutes"
              type="number"
              min={1}
              max={1440}
              placeholder="off"
              value={rateWindow}
              onChange={(e) => setRateWindow(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field
            label="When the limit is hit, reply once with:"
            hint="Sent word for word, by us, to the first message over the limit — the model never runs, so it costs nothing. Every further message in that window gets no reply at all, which is the point: a limit that answered every message would be an amplifier. Required once there is a limit."
          >
            <textarea
              name="rateNotice"
              rows={2}
              required={rateArmed}
              maxLength={2000}
              value={rateNotice}
              onChange={(e) => setRateNotice(e.target.value.slice(0, 2000))}
              placeholder="You're sending messages faster than I can answer — I'll pick this up again shortly."
              className={TEXTAREA_CLS}
            />
          </Field>
          {rateIncomplete && (
            <p className="-mt-2 text-[11px] text-err">
              Fill in all three — how many messages, how long the window is, and the reply to send
              — or clear all three to switch the limit off. A notice of only spaces counts as
              missing: we trim it, so a stray space can never quietly switch a limit off while it
              still looks set on screen.
            </p>
          )}
        </div>

        <Field
          label="Auto-resolve after inactivity"
          hint="Conversations idle this long resolve automatically (up to 720h). Blank = never — a new message always reopens"
        >
          <div className="flex items-center gap-2">
            <Input
              name="autoResolveH"
              type="number"
              min={0}
              max={720}
              placeholder="0"
              aria-label="Hours"
              defaultValue={
                initial?.autoResolveMinutes ? Math.floor(initial.autoResolveMinutes / 60) || '' : ''
              }
              className="font-mono"
            />
            <span className="shrink-0 text-[12px] text-t3">hours</span>
            <Input
              name="autoResolveM"
              type="number"
              min={0}
              max={59}
              placeholder="0"
              aria-label="Minutes"
              defaultValue={initial?.autoResolveMinutes ? initial.autoResolveMinutes % 60 || '' : ''}
              className="font-mono"
            />
            <span className="shrink-0 text-[12px] text-t3">min</span>
          </div>
        </Field>
      </ConfigGroup>

      <ConfigGroup section="edit" active={section}>
        <Field label="Description">
          <Input name="description" placeholder="What this agent handles (optional)" defaultValue={initial?.description ?? ''} />
        </Field>

        {/* Agent-speaks-first — used by the in-app chat widget. */}
        <div>
          <span className="mb-1.5 block text-[12px] font-medium text-t2">Welcome message</span>
          <textarea
            value={welcome}
            onChange={(e) => setWelcome(e.target.value.slice(0, 2000))}
            maxLength={2000}
            rows={3}
            placeholder="Hi! I'm the Acme assistant — ask me anything about your account."
            className="w-full rounded-md border border-bd bg-transparent px-2.5 py-2 text-[13px] text-t1 placeholder:text-t3 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[11px] text-t3">
              The agent's opening line when a chat starts — blank sends nothing.
            </span>
            <Mono className="text-t3">{welcome.length}/2000</Mono>
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-[12px] font-medium text-t2">Suggested prompts</span>
          <p className="mb-2 text-[11px] text-t3">
            Up to 6 starter chips shown under the welcome — the title is the chip, the message is
            what it sends. Empty saves none.
          </p>
          {prompts.length > 0 && (
            <div className="space-y-2">
              {prompts.map((p, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="flex-1">
                    <Input
                      value={p.title}
                      maxLength={40}
                      placeholder="Reset password"
                      aria-label={`Prompt ${i + 1} title`}
                      onChange={(e) => {
                        const title = e.target.value.slice(0, 40);
                        setPrompts((prev) => prev.map((q, j) => (j === i ? { ...q, title } : q)));
                      }}
                    />
                    <div className="mt-1 text-right">
                      <Mono className="text-t3">{p.title.length}/40</Mono>
                    </div>
                  </div>
                  <div className="flex-[2]">
                    <Input
                      value={p.message}
                      maxLength={200}
                      placeholder="How do I reset my password?"
                      aria-label={`Prompt ${i + 1} message`}
                      onChange={(e) => {
                        const message = e.target.value.slice(0, 200);
                        setPrompts((prev) => prev.map((q, j) => (j === i ? { ...q, message } : q)));
                      }}
                    />
                    <div className="mt-1 text-right">
                      <Mono className="text-t3">{p.message.length}/200</Mono>
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove prompt ${i + 1}`}
                    onClick={() => setPrompts((prev) => prev.filter((_, j) => j !== i))}
                    className="h-8 shrink-0 px-1.5 text-[12px] text-t3 transition-colors hover:text-t1"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          {prompts.length < 6 && (
            <button
              type="button"
              onClick={() => setPrompts((prev) => [...prev, { title: '', message: '' }])}
              className="mt-2 text-[12px] text-t3 transition-colors hover:text-t1"
            >
              + Add prompt
            </button>
          )}
        </div>
      </ConfigGroup>

      {/* Everything from here down is the save itself — the eval strip, the
          error line and the footer — so it shows on EVERY config tab: there is
          one Save, and it is wherever the operator is. */}
      {evalGateOn && (
        <div className="flex items-center justify-between gap-3 border-t border-bd pt-4">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
              style={{ background: advisoryDot }}
            />
            <Mono className="truncate text-t3">{advisory ? advisory.text : 'evals: none run yet'}</Mono>
          </span>
          <Button
            type="button"
            onClick={() => runEvals.mutate()}
            disabled={runEvals.isPending || latestRun?.status === 'running'}
          >
            {runEvals.isPending || latestRun?.status === 'running' ? 'Running…' : 'Run evals'}
          </Button>
        </div>
      )}

      {/* A4: the quiet counterpart to the check — an agent with no enabled eval
          has nothing to check a prompt edit against, and should know it. */}
      {evalGateOn && evalsQuery.isSuccess && enabledEvals === 0 && (
        <p className="-mt-2 text-[11px] text-t3">
          No evals enabled — with one, a prompt or model edit is run against it before Save
          commits.
        </p>
      )}

      {error && <p className="text-[12px] text-err">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        {footerExtra}
        {!hideCancel && (
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
    {/* Outside the <form> on purpose: a nested submit button would re-fire this
        save. Cancel just drops the pending body — the edit stays in the fields. */}
    {pendingSave && (
      <PreSaveCheck
        identifier={identifier}
        candidate={pendingSave.candidate}
        baseline={baselineRun(runsQuery.data?.runs ?? [])}
        evalCount={enabledEvals}
        onSave={() => {
          const body = pendingSave.body;
          setPendingSave(null);
          onSubmit(body);
        }}
        onCancel={() => setPendingSave(null)}
      />
    )}
    {/* The validation tip: dashboard chrome (elevated step + 1px border, no
        shadow), err reserved for the status dot, 12px text — a StatusBadge
        that happens to float. Portaled so a transformed ancestor (the create
        modal's entrance) can never re-anchor the fixed positioning. */}
    {invalidTip &&
      createPortal(
        // Two nested divs on purpose: the outer one owns position (including
        // the translateY(-50%) that centres a right-side tip on the field),
        // the inner one owns the entrance — modal-in animates `transform`,
        // and both on one element would fight.
        <div
          className="fixed z-50"
          style={{
            left: invalidTip.x,
            top: invalidTip.y,
            transform: invalidTip.side === 'right' ? 'translateY(-50%)' : undefined,
          }}
        >
          <div
            role="alert"
            className="flex max-w-xs items-baseline gap-2 rounded-md border border-bd-strong bg-elevated px-3 py-2 text-[12px] text-t1"
            style={{ animation: 'modal-in 150ms ease' }}
          >
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-err" />
            {invalidTip.message}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Detail page config panel — the full AgentForm + save (PATCH) + agent-level
 * rotate, rendered on all four config tabs. The page keeps ONE instance of this
 * mounted across Edit / Guardrails / Cost & routing / Memory and only changes
 * `section`, so switching tabs never loses an unsaved edit and never costs a
 * refetch; `onRequestSection` lets a validation failure pull the operator to
 * the tab that can show it.
 */
export function ConfigPanel({
  agent,
  section,
  onRequestSection,
}: {
  agent: Agent;
  section: ConfigSection;
  onRequestSection: (section: ConfigSection) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');

  const update = useMutation({
    mutationFn: ({ identifier, ...body }: Partial<AgentBody> & { identifier: string }) =>
      api(`/v1/agents/${identifier}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setError('');
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (err) => setError(err.message),
  });

  const rotate = useMutation({
    mutationFn: (identifier: string) =>
      api<{ signingSecret: string }>(`/v1/agents/${identifier}/rotate-secret`, { method: 'POST' }),
    onSuccess: (res) => setSecret(res.signingSecret),
  });

  return (
    <div className="max-w-xl">
      <AgentForm
        initial={agent}
        pending={update.isPending}
        error={error}
        submitLabel="Save changes"
        hideCancel
        section={section}
        onRequestSection={onRequestSection}
        footerExtra={
          <Button type="button" onClick={() => rotate.mutate(agent.identifier)}>
            Rotate secret
          </Button>
        }
        onSubmit={(body) =>
          update.mutate({
            identifier: agent.identifier,
            name: body.name,
            description: body.description,
            runtime: body.runtime,
            bridgeUrl: body.bridgeUrl,
            model: body.model,
            systemPrompt: body.systemPrompt,
            maxTokens: body.maxTokens,
            autoResolveMinutes: body.autoResolveMinutes,
            welcomeMessage: body.welcomeMessage,
            suggestedPrompts: body.suggestedPrompts,
            maxDailyTokens: body.maxDailyTokens,
            context: body.context,
            routing: body.routing,
            topics: body.topics,
            moderation: body.moderation,
            subscriberRate: body.subscriberRate,
            llm: body.llm,
          })
        }
        onCancel={() => {}}
      />
      {secret && <SecretReveal secret={secret} onClose={() => setSecret('')} />}
    </div>
  );
}
