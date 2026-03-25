import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { config } from '../config';


export async function dispatchWebhook(
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Find all active webhooks subscribed to this event
  const webhooks = await prisma.webhook.findMany({
    where: {
      isActive: true,
      events: { has: event },
    },
  });

  for (const webhook of webhooks) {
    try {
      const body = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString() });
      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(body)
        .digest('hex');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.webhook.timeoutMs);

      try {
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Agora-Signature': signature,
            'X-Agora-Event': event,
          },
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          logger.warn('Webhook delivery failed', {
            webhookId: webhook.id,
            event,
            status: response.status,
          });
        } else {
          logger.info('Webhook delivered', { webhookId: webhook.id, event });
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      logger.error('Webhook dispatch error', {
        webhookId: webhook.id,
        event,
        error: (err as Error).message,
      });
    }
  }
}
