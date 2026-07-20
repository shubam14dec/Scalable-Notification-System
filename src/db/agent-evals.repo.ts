/**
 * Data layer for Phase 22 per-agent evals: the scenario registry (agent_evals)
 * and the run ledger (agent_eval_runs). CRUD is (tenant, agent)-scoped; runs are
 * created 'running' by the API route and finalized by the eval-run worker.
 */
import { pool } from './pool';

export interface AgentEval {
  id: string;
  tenant_id: string;
  agent_id: string;
  name: string;
  scenario: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type EvalRunStatus = 'running' | 'passed' | 'failed' | 'error';

/** Frozen per-scenario verdict persisted in agent_eval_runs.results. */
export interface EvalRunScenarioResult {
  name: string;
  passed: boolean;
  failures: string[];
  attempts: number;
}

export interface AgentEvalRun {
  id: string;
  tenant_id: string;
  agent_id: string;
  status: EvalRunStatus;
  trigger: 'manual' | 'pre_save';
  results: EvalRunScenarioResult[];
  started_at: string;
  finished_at: string | null;
}

/* ---------------- evals (scenarios) ---------------- */

export async function listEvals(tenantId: string, agentId: string): Promise<AgentEval[]> {
  const { rows } = await pool.query(
    `select * from agent_evals
      where tenant_id = $1 and agent_id = $2
      order by created_at asc`,
    [tenantId, agentId],
  );
  return rows;
}

/** ENABLED evals for a run — the worker drives only these. */
export async function listEnabledEvals(tenantId: string, agentId: string): Promise<AgentEval[]> {
  const { rows } = await pool.query(
    `select * from agent_evals
      where tenant_id = $1 and agent_id = $2 and enabled = true
      order by created_at asc`,
    [tenantId, agentId],
  );
  return rows;
}

export async function getEval(tenantId: string, id: string): Promise<AgentEval | null> {
  const { rows } = await pool.query('select * from agent_evals where tenant_id = $1 and id = $2', [
    tenantId,
    id,
  ]);
  return rows[0] ?? null;
}

/** null = the (agent, name) pair is already taken. */
export async function createEval(d: {
  tenantId: string;
  agentId: string;
  name: string;
  scenario: Record<string, unknown>;
  enabled: boolean;
}): Promise<AgentEval | null> {
  const { rows } = await pool.query(
    `insert into agent_evals (tenant_id, agent_id, name, scenario, enabled)
     values ($1,$2,$3,$4,$5)
     on conflict (agent_id, name) do nothing
     returning *`,
    [d.tenantId, d.agentId, d.name, JSON.stringify(d.scenario), d.enabled],
  );
  return rows[0] ?? null;
}

/** Patch mutable fields; absent leaves untouched. null = row not found. */
export async function updateEval(
  tenantId: string,
  id: string,
  patch: { name?: string; scenario?: Record<string, unknown>; enabled?: boolean },
): Promise<AgentEval | null> {
  const { rows } = await pool.query(
    `update agent_evals set
       name       = coalesce($3, name),
       scenario   = coalesce($4, scenario),
       enabled    = coalesce($5, enabled),
       updated_at = now()
     where tenant_id = $1 and id = $2
     returning *`,
    [
      tenantId,
      id,
      patch.name ?? null,
      patch.scenario ? JSON.stringify(patch.scenario) : null,
      patch.enabled ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function deleteEval(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('delete from agent_evals where tenant_id = $1 and id = $2', [
    tenantId,
    id,
  ]);
  return (rowCount ?? 0) > 0;
}

/* ---------------- runs ---------------- */

export async function createRun(d: {
  tenantId: string;
  agentId: string;
  trigger: 'manual' | 'pre_save';
}): Promise<AgentEvalRun> {
  const { rows } = await pool.query(
    `insert into agent_eval_runs (tenant_id, agent_id, trigger)
     values ($1,$2,$3)
     returning *`,
    [d.tenantId, d.agentId, d.trigger],
  );
  return rows[0];
}

/**
 * Finalize a run: set the terminal status + per-scenario results + finished_at.
 * Guarded on status='running' so a retried job can't overwrite a finished run.
 */
export async function finishRun(
  id: string,
  status: Exclude<EvalRunStatus, 'running'>,
  results: EvalRunScenarioResult[],
): Promise<void> {
  await pool.query(
    `update agent_eval_runs
        set status = $2, results = $3, finished_at = now()
      where id = $1 and status = 'running'`,
    [id, status, JSON.stringify(results)],
  );
}

export async function getRun(tenantId: string, id: string): Promise<AgentEvalRun | null> {
  const { rows } = await pool.query(
    'select * from agent_eval_runs where tenant_id = $1 and id = $2',
    [tenantId, id],
  );
  return rows[0] ?? null;
}

/** getRun without a tenant scope — the worker owns the id it was handed. */
export async function getRunById(id: string): Promise<AgentEvalRun | null> {
  const { rows } = await pool.query('select * from agent_eval_runs where id = $1', [id]);
  return rows[0] ?? null;
}

export async function listRuns(
  tenantId: string,
  agentId: string,
  limit = 20,
): Promise<AgentEvalRun[]> {
  const { rows } = await pool.query(
    `select * from agent_eval_runs
      where tenant_id = $1 and agent_id = $2
      order by started_at desc
      limit $3`,
    [tenantId, agentId, Math.min(limit, 100)],
  );
  return rows;
}
