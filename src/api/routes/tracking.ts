import type { FastifyInstance } from 'fastify';
import { markMessageOpened } from '../../db/repositories';
import { logExec } from '../../core/execution-log';

// 1x1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * Email open tracking. The pixel URL is a capability URL — the message id
 * (uuid) is the secret, the standard pattern for tracking pixels. Always
 * returns the image, even for unknown ids, so mail clients never see errors.
 */
export function registerTrackingRoutes(app: FastifyInstance) {
  app.get<{ Params: { messageId: string } }>('/o/:messageId', async (req, reply) => {
    const messageId = req.params.messageId.replace(/\.gif$/, '');
    if (/^[0-9a-f-]{36}$/.test(messageId)) {
      const message = await markMessageOpened(messageId).catch(() => null);
      if (message && message.opened_at) {
        logExec({
          tenantId: message.tenant_id,
          transactionId: message.transaction_id,
          messageId: message.id,
          level: 'info',
          detail: 'email opened (tracking pixel)',
        });
      }
    }
    reply
      .header('content-type', 'image/gif')
      .header('cache-control', 'no-store, max-age=0')
      .send(PIXEL);
  });
}
