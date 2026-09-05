import type { ObjectId } from 'mongodb';

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

/**
 * `pending`  queued, not yet attempted
 * `sent`     a provider accepted it
 * `failed`   permanently — a bad address, or out of attempts
 * `suppressed` deliberately not sent (no address on file for that channel)
 */
export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'suppressed';

export interface NotificationDoc {
  _id?: ObjectId;
  /** The thing this is about — booking, adjustment or invoice reference. */
  entityId: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  to: string;
  subject: string;
  body: string;
  bookingRef: string;
  status: NotificationStatus;
  /** How many times a transport has been asked to carry it. */
  attempts: number;
  lastAttemptAt: Date | null;
  /** Not before this time — how backoff is expressed. */
  nextAttemptAt: Date;
  /** The provider's own id, for tracing a support query. */
  providerId: string | null;
  /** Which transport carried it, so a switch of provider is visible in history. */
  transport: string | null;
  error: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

/**
 * Five attempts over roughly twenty minutes, then give up.
 *
 * Long enough to ride out a provider blip or a DNS wobble; short enough that a
 * genuinely undeliverable message surfaces in the admin panel while the
 * shipment it concerns is still on the floor. A message nobody looks at for a
 * day is not a notification.
 */
export const MAX_ATTEMPTS = 5;

export const backoffMs = (attempt: number): number =>
  Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
