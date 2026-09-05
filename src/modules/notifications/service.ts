import { COLLECTIONS, collection } from '../../db/mongo.js';
import { dispatchPending } from './dispatcher.js';
import { render, type TemplateData } from './templates.js';
import type { NotificationChannel, NotificationDoc, NotificationEvent } from './types.js';

export type { NotificationChannel, NotificationDoc, NotificationEvent } from './types.js';

/**
 * Customer notifications.
 *
 * This module decides *what* to send and to whom, and guarantees it goes once.
 * Carrying it is a transport's job (`transports.ts`) and retrying is the
 * dispatcher's (`dispatcher.ts`). Business code calls `queue()` and moves on —
 * it never waits on an SMTP handshake to finish serving a request.
 */

const notifications = () => collection<NotificationDoc>(COLLECTIONS.notifications);

export interface QueueRequest {
  entityId: string;
  event: NotificationEvent;
  bookingRef: string;
  to: { email?: string; mobile?: string };
  data: TemplateData;
}

/**
 * Queue one message per available channel.
 *
 * The unique index on (entityId, event, channel) is what makes this safe to
 * call twice. A retried worker, a double-clicked approve button and a replayed
 * webhook all collide on it, and a duplicate key is success, not failure — the
 * customer already has that message. Anything else is a real error and rethrown.
 */
export const queue = async (request: QueueRequest): Promise<NotificationDoc[]> => {
  const rendered = render(request.event, request.data);
  const now = new Date();

  const targets: { channel: NotificationChannel; to: string; body: string }[] = [];
  if (request.to.email) targets.push({ channel: 'email', to: request.to.email, body: rendered.email });
  if (request.to.mobile) targets.push({ channel: 'sms', to: request.to.mobile, body: rendered.sms });

  const written: NotificationDoc[] = [];

  for (const target of targets) {
    const doc: NotificationDoc = {
      entityId: request.entityId,
      event: request.event,
      channel: target.channel,
      to: target.to,
      subject: rendered.subject,
      body: target.body,
      bookingRef: request.bookingRef,
      status: 'pending',
      attempts: 0,
      lastAttemptAt: null,
      nextAttemptAt: now,
      providerId: null,
      transport: null,
      error: null,
      createdAt: now,
      sentAt: null,
    };

    try {
      await notifications().insertOne(doc);
      written.push(doc);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) continue;
      throw error;
    }
  }

  return written;
};

/**
 * Queue, then try immediately rather than waiting for the next tick.
 *
 * "Real-time notification of a price adjustment" is requirement 3.1, and up to
 * fifteen seconds of queue latency is not what anyone means by real time when
 * the customer is standing at the counter. The dispatcher still owns retries;
 * this only skips the wait for the happy path, and never lets a transport
 * failure surface as a failed booking.
 */
export const send = async (request: QueueRequest): Promise<void> => {
  const written = await queue(request);
  if (written.length === 0) return;
  await dispatchPending(written.length).catch(() => undefined);
};

export const listForBooking = async (bookingRef: string): Promise<NotificationDoc[]> =>
  notifications().find({ bookingRef }).sort({ createdAt: -1 }).toArray();

export const listRecent = async (limit = 60): Promise<NotificationDoc[]> =>
  notifications().find({}).sort({ createdAt: -1 }).limit(limit).toArray();

/** What the operations panel shows at a glance. */
export const queueHealth = async (): Promise<{
  pending: number;
  failed: number;
  sentToday: number;
}> => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [pending, failed, sentToday] = await Promise.all([
    notifications().countDocuments({ status: 'pending' }),
    notifications().countDocuments({ status: 'failed' }),
    notifications().countDocuments({ status: 'sent', sentAt: { $gte: startOfDay } }),
  ]);

  return { pending, failed, sentToday };
};
