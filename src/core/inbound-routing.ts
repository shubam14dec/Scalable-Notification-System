import { getAgentById, type Agent, type AgentConnection } from '../db/conversations.repo';

/** v1: the connection's mutable agent_id IS the routing table.
 *  Phase 13 (Slack) adds a scope param + matcher lookup here — the four
 *  webhook call sites must not change when that lands. */
export async function resolveAgentForInbound(
  connection: AgentConnection,
): Promise<Agent | null> {
  if (connection.status !== 'active') return null;
  const agent = await getAgentById(connection.agent_id);
  if (!agent || agent.status !== 'active') return null;
  return agent;
}
