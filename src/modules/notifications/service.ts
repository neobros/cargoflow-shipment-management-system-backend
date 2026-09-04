import type { ObjectId } from 'mongodb';
import { COLLECTIONS, collection } from '../../db/mongo.js';

/**
 * Customer notifications.
 *
 * No email or SMS provider is wired up — that is a credential and a contract,
 * not a design decision, and the point of this module is the part that is ours:
 * deciding what to send, to whom, and making sure it is sent exactly once.
 *
 * `queue()` writes the message and returns. A real deployment runs a worker
 * over `status: 'pending'`; here `deliver()` marks them sent so the flow can be
 * followed end to end. The rendered body is stored either way, so what the
 * customer would have received is auditable rather than notional.
 */

export type NotificationChannel = 'email' | 'sms';

export type NotificationEvent =
  | 'booking_confirmed'
  | 'received_at_depot'
  | 'price_changed'
  | 'price_settled'
  | 'price_reminder'
  | 'invoice_issued'
  | 'loaded_into_container'
  | 'departed';

export interface NotificationDoc {
  _id?: ObjectId;
  /** The thing this is about — booking, adjustment or invoice id, as a string. */
  entityId: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  to: string;
  subject: string;
  body: string;
  bookingRef: string;
  status: 'pending' | 'sent' | 'failed' | 'suppressed';
  createdAt: Date;
  sentAt: Date | null;
  error: string | null;
}

const notifications = () => collection<NotificationDoc>(COLLECTIONS.notifications);

export interface QueueRequest {
  entityId: string;
  event: NotificationEvent;
  bookingRef: string;
  to: { email?: string; mobile?: string };
  subject: string;
  body: string;
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
  const targets: { channel: NotificationChannel; to: string }[] = [];
  if (request.to.email) targets.push({ channel: 'email', to: request.to.email });
  if (request.to.mobile) targets.push({ channel: 'sms', to: request.to.mobile });

  const written: NotificationDoc[] = [];

  for (const target of targets) {
    const doc: NotificationDoc = {
      entityId: request.entityId,
      event: request.event,
      channel: target.channel,
      to: target.to,
      subject: request.subject,
      // An SMS is not a shortened email. 160 characters, no subject line, and
      // the tracking link has to survive being read aloud.
      body: target.channel === 'sms' ? smsBody(request) : request.body,
      bookingRef: request.bookingRef,
      status: 'pending',
      createdAt: new Date(),
      sentAt: null,
      error: null,
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

const smsBody = (request: QueueRequest): string => {
  const first = request.body.split('\n').find((line) => line.trim().length > 0) ?? request.subject;
  const trimmed = first.trim();
  const suffix = ` Track: ${request.bookingRef}`;
  const room = 160 - suffix.length;
  return (trimmed.length > room ? `${trimmed.slice(0, room - 1)}…` : trimmed) + suffix;
};

/**
 * Hand the queue to the provider. There isn't one, so this only flips the
 * state — but it is the seam a real ESP drops into, and everything downstream
 * already reads `sentAt`.
 */
export const deliver = async (limit = 50): Promise<number> => {
  const pending = await notifications()
    .find({ status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();

  if (pending.length === 0) return 0;

  await notifications().updateMany(
    { _id: { $in: pending.map((n) => n._id!) } },
    { $set: { status: 'sent', sentAt: new Date() } },
  );

  return pending.length;
};

/** Queue and hand over in one step, for flows that have nothing else to do. */
export const send = async (request: QueueRequest): Promise<void> => {
  const written = await queue(request);
  if (written.length === 0) return;
  await notifications().updateMany(
    { entityId: request.entityId, event: request.event, status: 'pending' },
    { $set: { status: 'sent', sentAt: new Date() } },
  );
};

export const listForBooking = async (bookingRef: string): Promise<NotificationDoc[]> =>
  notifications().find({ bookingRef }).sort({ createdAt: -1 }).toArray();

export const listRecent = async (limit = 60): Promise<NotificationDoc[]> =>
  notifications().find({}).sort({ createdAt: -1 }).limit(limit).toArray();
