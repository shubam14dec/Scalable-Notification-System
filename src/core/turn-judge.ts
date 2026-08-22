/**
 * A5 slice C — sampled LLM judging of REAL turns during a canary trial.
 *
 * A canary answers "is the trial version better or worse than live?", and
 * counters alone cannot answer it: two arms can resolve at the same rate while
 * one of them invents facts. So a sampled share of replies — in BOTH arms, at
 * the SAME rate — is graded after the fact by the A2 judge, and the panel
 * compares the averages.
 *
 * BOTH ARMS, deliberately. Judging only the canary would produce a number with
 * nothing to compare it against: "groundedness 4.2" means nothing without the
 * live prompt's 4.2 (or 3.1) measured the same way, on the same traffic, by the
 * same judge. An unjudged control arm is not a control.
 *
 * NEVER ON THE CUSTOMER'S PATH. Everything here runs after the reply has been
 * inserted AND delivered, and the entry point below cannot throw or await
 * anything the caller depends on: the decision is a coin flip, the work is one
 * enqueue, and every failure is swallowed with a log. A broken judge queue
 * degrades the comparison, never the product.
 */
import { logger } from '../shared/logger';
import { getQueue, QUEUE } from '../shared/queues';
import {
  canaryArmStats,
  canaryJudgedStats,
  conversationTranscriptThrough,
  getAgentById,
  getAgentPromptVersion,
  getConversation,
  getConversationMessage,
  insertTurnJudgments,
  SAMPLE_PERCENT_DEFAULT,
  type Agent,
  type CanaryArmStats,
  type CanaryJudgedStat,
} from '../db/conversations.repo';
import { judgeReply, judgeTemperatureFor, type JudgeClient, type JudgeSpec } from './eval-judge';
import { buildManagedClient, DEFAULT_MODEL } from './managed-brain';

export interface TurnJudgeJobData {
  tenantId: string;
  agentId: string;
  conversationId: string;
  /** The reply row under judgment. Doubles as the job id — one job per reply. */
  messageId: string;
  /**
   * The canary version that ACTUALLY SERVED this reply, or null for the live
   * prompt. Captured at reply time from the same value stamped into
   * raw.canaryVersion, so the stored attribution can never drift from what the
   * customer was actually answered by — see schema.sql on agent_turn_judgments.
   */
  canaryVersion: number | null;
}

/**
 * The dimensions a canary judges. Groundedness and tone ONLY — the two that
 * are scored 1-5 and therefore averageable across an arm.
 *
 * No refusal: it is a verdict, not a score, and it is only meaningful against a
 * scenario author's declaration of which way the reply SHOULD have gone. Real
 * traffic carries no such declaration, so a refusal verdict here would be the
 * judge inventing the requirement it then grades against.
 *
 * `tone: {}` — no rubric, on purpose. A rubric is a scenario author's extra
 * instruction; live traffic has no author, so tone falls back to grading
 * against the agent's own persona (and, for a personaless agent, the judge's
 * generic-professional baseline) exactly as the CLI does.
 */
export const CANARY_JUDGE_SPEC: JudgeSpec = { groundedness: true, tone: {} };

/** How many transcript rows of evidence the judge sees. Matches the eval path. */
const TRANSCRIPT_LIMIT = 40;

/**
 * The sampling coin flip. Exported pure so a test can pin the roll instead of
 * fighting Math.random.
 *
 * `null` percent = a trial started before this slice shipped (its Start never
 * wrote the column): fall back to the default rather than silently judging
 * nothing, since an operator who started a canary wants the comparison.
 * `0` is the explicit "counters only" opt-out and is honoured exactly.
 */
export function shouldJudgeTurn(samplePercent: number | null, roll: number): boolean {
  const percent = samplePercent ?? SAMPLE_PERCENT_DEFAULT;
  if (percent <= 0) return false;
  return roll * 100 < percent;
}

/**
 * Decide and enqueue. THE ENTRY POINT — and it never rejects, which is what
 * makes `void judgeTurnIfSampled(...)` safe at the call site: the customer's
 * reply is already delivered by the time this runs, and no failure in here can
 * reach the turn that produced it.
 *
 * Skips (each free, in cheapening order): no trial running on the agent; this
 * conversation was never enrolled in one; the coin flip missed.
 */
export async function judgeTurnIfSampled(args: {
  agent: Pick<Agent, 'id' | 'canary_version' | 'canary_sample_percent' | 'runtime'>;
  /** The arm the CONVERSATION was enrolled in — null means it opened outside any trial. */
  arm: 'canary' | 'control' | null;
  tenantId: string;
  conversationId: string;
  messageId: string;
  /** What actually served the reply (raw.canaryVersion), null = the live prompt. */
  canaryVersion: number | null;
  roll?: number;
}): Promise<void> {
  try {
    if (args.agent.runtime !== 'managed') return;
    // canary_version is the one authoritative "a trial is running" test, the
    // same one slice B's injection and the report route use.
    if (args.agent.canary_version === null) return;
    if (args.arm === null) return;
    if (!shouldJudgeTurn(args.agent.canary_sample_percent, args.roll ?? Math.random())) return;

    const data: TurnJudgeJobData = {
      tenantId: args.tenantId,
      agentId: args.agent.id,
      conversationId: args.conversationId,
      messageId: args.messageId,
      canaryVersion: args.canaryVersion,
    };
    await getQueue(QUEUE.TURN_JUDGE).add(`judge-${args.messageId}`, data, {
      // One judgment per reply: a redelivered turn cannot enqueue a second job
      // while the first is still known to BullMQ. The unique (message_id, dim)
      // row constraint is the backstop for everything that outlives the job.
      jobId: `judge-${args.messageId}`,
      // Fewer attempts than the pipeline default: a judgment is evidence, not
      // an obligation. Losing one costs a data point; retrying it five times
      // costs five model calls the operator never asked for.
      attempts: 2,
    });
  } catch (err) {
    // Deliberately terminal. Judging is best-effort background evidence; the
    // reply it grades has already reached the customer.
    logger.warn(
      { err: (err as Error).message, messageId: args.messageId },
      'canary turn judging could not be enqueued — comparison loses one sample',
    );
  }
}

/**
 * Judge one already-delivered reply and store its raw scores.
 *
 * Self-judge posture, inherited from A2 and A4: the judge rides the AGENT's own
 * client and the model that SERVED the turn. For a canary turn that means the
 * candidate model from the version snapshot — grading a trial reply on the live
 * model would mix two configs and quietly measure the wrong thing.
 *
 * DEGRADES, NEVER STORMS. Every reason a judgment cannot be produced (agent or
 * row gone, trial ended, credentials missing, base URL blocked) returns quietly
 * with a log instead of throwing, because none of them is fixable by running
 * the same job again — and a retry loop here would bill the customer's own LLM
 * key for it. Only genuinely transient faults (the judge call itself) are
 * allowed to throw into BullMQ's one remaining attempt.
 */
export async function judgeTurn(
  data: TurnJudgeJobData,
  deps: { buildClient?: (a: Agent) => Promise<JudgeClient> } = {},
): Promise<void> {
  const { tenantId, agentId, conversationId, messageId, canaryVersion } = data;
  const buildClient = deps.buildClient ?? buildManagedClient;

  const agent = await getAgentById(agentId);
  if (!agent || agent.runtime !== 'managed') {
    logger.debug({ agentId }, 'turn judge skipped: agent gone or not managed');
    return;
  }
  // getConversation is tenant-scoped, so this read is also the authorization
  // check: a job whose tenantId doesn't own the conversation finds nothing and
  // grades nothing, rather than reading another tenant's transcript into a
  // judge prompt. getConversationMessage is keyed by id alone, which is why the
  // scoped read has to be the one that gates it.
  const conversation = await getConversation(tenantId, conversationId);
  const row = await getConversationMessage(messageId);
  if (
    !conversation ||
    !row ||
    row.conversation_id !== conversationId ||
    row.role !== 'agent' ||
    !row.content
  ) {
    logger.debug({ messageId }, 'turn judge skipped: reply row gone or not a reply');
    return;
  }

  // WHICH CONFIG WROTE THIS REPLY — the judge must grade the reply against the
  // persona that produced it (A4's rule: tone asks "does this match the
  // persona?", so the persona under test is the candidate one). A canary turn
  // is graded against its snapshot; everything else against the live agent.
  let systemPrompt = agent.system_prompt;
  // The live model resolves the same way the brain resolves it, so the judge
  // temperature predicate runs on the id that actually served the turn.
  let model = agent.model ?? DEFAULT_MODEL;
  if (canaryVersion !== null) {
    const snapshot = await getAgentPromptVersion(agentId, canaryVersion);
    if (!snapshot) {
      // The version was deleted under a running trial. There is no honest way
      // to grade the reply's tone against a persona we no longer have, and
      // guessing with the live one would score the wrong question.
      logger.debug({ agentId, canaryVersion }, 'turn judge skipped: version snapshot gone');
      return;
    }
    systemPrompt = snapshot.system_prompt;
    model = snapshot.model ?? DEFAULT_MODEL;
  }

  let client: JudgeClient;
  try {
    client = await buildClient(agent);
  } catch (err) {
    // No credentials / blocked base URL. Permanent by nature — a retry storm
    // against a misconfigured agent is worse than a missing data point.
    logger.warn(
      { err: (err as Error).message, agent: agent.identifier },
      'turn judge unavailable — canary comparison loses this sample',
    );
    return;
  }

  // The A2 evidence window: every row from the start of the thread THROUGH the
  // judged reply. Nothing after it — a claim cannot be grounded in evidence
  // that did not exist when the reply was written.
  const transcript = await conversationTranscriptThrough(
    conversationId,
    messageId,
    TRANSCRIPT_LIMIT,
  );

  const verdicts = await judgeReply({
    client,
    model,
    transcript,
    reply: row.content,
    systemPrompt,
    spec: CANARY_JUDGE_SPEC,
    temperature: judgeTemperatureFor(model),
  });

  const written = await insertTurnJudgments(
    verdicts
      // Both requested dimensions are scored, so a verdict without a score is
      // a malformed judge response for THIS spec — drop it rather than store a
      // row that would break the average.
      .filter((v) => typeof v.score === 'number')
      .map((v) => ({
        tenantId,
        agentId,
        conversationId,
        messageId,
        // What SERVED the turn, not what the conversation was enrolled in.
        arm: canaryVersion !== null ? ('canary' as const) : ('control' as const),
        canaryVersion,
        dim: v.dim,
        score: v.score as number,
        rationale: v.rationale,
      })),
  );
  logger.debug(
    { messageId, written, arm: canaryVersion !== null ? 'canary' : 'control' },
    'turn judged',
  );
}

// ---- the report ------------------------------------------------------------

export interface CanaryReport {
  version: number;
  percent: number | null;
  samplePercent: number;
  startedAt: string;
  arms: Array<
    CanaryArmStats & {
      /** dim -> {avg, n}. Empty until the first sampled turn is judged. */
      judged: Record<string, { avg: number; n: number }>;
    }
  >;
}

/**
 * Assemble the comparison for an agent's CURRENT trial. Two set-based queries
 * (counters, judged averages) — never a per-conversation or per-turn loop, so
 * the cost tracks the trial's size and not the tenant's history. See the SQL
 * comments in conversations.repo.ts for the index each one rides.
 */
export async function buildCanaryReport(agent: Agent): Promise<CanaryReport | null> {
  if (agent.canary_version === null || agent.canary_started_at === null) return null;
  const [stats, judged] = await Promise.all([
    canaryArmStats(agent.id, agent.canary_started_at, agent.canary_version),
    canaryJudgedStats(agent.id, agent.canary_started_at, agent.canary_version),
  ]);
  const byArm = (arm: string): Record<string, { avg: number; n: number }> =>
    Object.fromEntries(
      judged
        .filter((j: CanaryJudgedStat) => j.arm === arm)
        .map((j) => [j.dim, { avg: j.avg, n: j.n }]),
    );
  return {
    version: agent.canary_version,
    percent: agent.canary_percent,
    samplePercent: agent.canary_sample_percent ?? SAMPLE_PERCENT_DEFAULT,
    startedAt: agent.canary_started_at,
    arms: stats.map((s: CanaryArmStats) => ({ ...s, judged: byArm(s.arm) })),
  };
}
