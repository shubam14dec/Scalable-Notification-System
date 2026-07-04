import type { Job } from 'bullmq';
import { addSuppression, updateMessageByProviderId, type MessageRow } from '../../db/repositories';
import { TransientError } from '../../shared/errors';
import { logExec } from '../../core/execution-log';

function suppressibleAddress(message: MessageRow): string | null {
  switch (message.channel) {
    case 'email':
      return message.content.to.email ?? null;
    case 'sms':
      return message.content.to.phone ?? null;
    case 'push':
      return message.content.to.pushToken ?? null;
    default:
      return null; // in-app inboxes never bounce
  }
}

const STATUS_MAP: Record<string, string> = {
  delivered: 'delivered',
  bounced: 'bounced',
  failed: 'failed',
  complaint: 'complaint',
};

/**
 * Applies provider delivery callbacks (delivered/bounced/...) to messages.
 * Retries when the message row isn't visible yet — providers sometimes call
 * back faster than our own 'sent' update commits.
 */
export async function processStatus(
  job: Job<{ provider: string; providerMessageId: string; status: string }>,
): Promise<void> {
  const { provider, providerMessageId, status } = job.data;
  const mapped = STATUS_MAP[status] ?? status;

  const message = await updateMessageByProviderId(providerMessageId, mapped);
  if (!message) {
    throw new TransientError(
      `no message with provider_message_id=${providerMessageId} yet (provider=${provider})`,
    );
  }

  logExec({
    tenantId: message.tenant_id,
    transactionId: message.transaction_id,
    messageId: message.id,
    level: mapped === 'delivered' ? 'info' : 'warn',
    detail: `provider ${provider} reported: ${mapped}`,
  });

  // Hard bounce / spam complaint -> suppress the address so future fan-outs
  // skip it. Sending to known-bad addresses tanks provider reputation.
  if (mapped === 'bounced' || mapped === 'complaint') {
    const address = suppressibleAddress(message);
    if (address) {
      await addSuppression(message.tenant_id, message.channel, address, mapped);
      logExec({
        tenantId: message.tenant_id,
        transactionId: message.transaction_id,
        messageId: message.id,
        level: 'warn',
        detail: `suppressed ${message.channel} address after ${mapped}`,
      });
    }
  }
}
