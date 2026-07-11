import { redis } from '../shared/redis';
import { inAppPubSubChannel } from '../providers/inapp';
import type { Agent, Conversation } from '../db/conversations.repo';

/** Live push over the same per-subscriber channel the inbox already uses. */
export async function publishConversationEvent(
  conversation: Conversation,
  subscriberExternalId: string,
  agent: Agent,
  event: Record<string, unknown>,
): Promise<void> {
  await redis.publish(
    inAppPubSubChannel(conversation.tenant_id, subscriberExternalId),
    JSON.stringify({
      ...event,
      conversation: {
        id: conversation.id,
        agentIdentifier: agent.identifier,
        agentName: agent.name,
      },
    }),
  );
}
