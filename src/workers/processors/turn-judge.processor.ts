/**
 * A5 slice C — the sampled-turn judge worker.
 *
 * One job = one already-delivered agent reply to grade. The work itself lives
 * in core/turn-judge.ts (beside the sampling decision that enqueued it, and the
 * report that reads what it writes); this file is the BullMQ seam.
 *
 * The processor takes ONLY `job`, deliberately: BullMQ passes a lock token as
 * the second argument, so a processor whose second parameter is an options or
 * dependency bag silently receives that token in production. Tests inject their
 * judge client through `judgeTurn`'s own `deps` instead — the same shape
 * eval-run.processor.ts uses for exactly this reason.
 */
import type { Job } from 'bullmq';

import { judgeTurn, type TurnJudgeJobData } from '../../core/turn-judge';

export async function processTurnJudge(job: Job<TurnJudgeJobData>): Promise<void> {
  await judgeTurn(job.data);
}
