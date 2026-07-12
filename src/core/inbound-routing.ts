import {
  getAgentById,
  getRoutingRule,
  type Agent,
  type AgentConnection,
} from '../db/conversations.repo';

/**
 * Who answers an inbound turn on this connection. The connection's mutable
 * agent_id is the default. Channels that route by sub-scope (slack: a channel
 * id within one workspace) pass `scope` — a matching routing rule steers to
 * its agent; a missing rule, or a rule whose agent is inactive, falls through
 * to the connection default. `scope` is optional so the DM/telegram/email call
 * sites compile and behave unchanged.
 */
export async function resolveAgentForInbound(
  connection: AgentConnection,
  scope?: string,
): Promise<Agent | null> {
  if (scope) {
    const rule = await getRoutingRule(connection.id, scope);
    if (rule) {
      const a = await getAgentById(rule.agent_id);
      if (a && a.status === 'active') return connection.status === 'active' ? a : null;
    }
  }
  if (connection.status !== 'active') return null;
  const agent = await getAgentById(connection.agent_id);
  if (!agent || agent.status !== 'active') return null;
  return agent;
}
