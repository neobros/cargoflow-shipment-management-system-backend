import { ObjectId } from 'mongodb';
import { COLLECTIONS, collection, withTransaction } from '../../db/mongo.js';
import { AppError } from '../../shared/errors.js';
import { formatMinor, formatMoney, money } from '../../shared/units.js';
import type { StaffDoc } from '../auth/types.js';
import type { AdjustmentDoc, BookingDoc, PieceDoc, PieceEventDoc } from '../shipments/types.js';

const bookings = () => collection<BookingDoc>(COLLECTIONS.bookings);
const pieces = () => collection<PieceDoc>(COLLECTIONS.pieces);
const adjustments = () => collection<AdjustmentDoc>(COLLECTIONS.adjustments);
const invoices = () => collection<Record<string, unknown>>(COLLECTIONS.invoices);
const notifications = () => collection<Record<string, unknown>>(COLLECTIONS.notifications);
const events = () => collection<PieceEventDoc>(COLLECTIONS.pieceEvents);

const hoursSince = (date: Date): number => (Date.now() - date.getTime()) / 3_600_000;

/** "1d 5h" — how long a customer has been kept waiting, in words a person uses. */
export const waitingFor = (since: Date): string => {
  const hours = Math.max(0, Math.floor(hoursSince(since)));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

export interface Exception {
  id: string;
  type: string;
  tone: 'alert' | 'warn' | 'muted';
  reference: string;
  what: string;
  waiting: string;
  waitingHours: number;
  action: { label: string; permission: string | null; href: string | null };
}

/**
 * Everything the system could not settle on its own, newest pain first.
 *
 * This is the admin home screen because it is the only screen an operator
 * actually needs open — a metrics wall tells you the business is fine, which
 * is not information you can act on.
 */
export const buildExceptions = async (): Promise<Exception[]> => {
  const out: Exception[] = [];

  const openAdjustments = await adjustments()
    .find({ state: { $in: ['awaiting_approval', 'declined'] } })
    .sort({ raisedAt: 1 })
    .limit(50)
    .toArray();

  for (const adjustment of openAdjustments) {
    const declined = adjustment.state === 'declined';
    out.push({
      id: adjustment.reference,
      type: declined ? 'Disputed' : 'Re-rate',
      tone: 'alert',
      reference: adjustment.bookingRef,
      what: declined
        ? 'Customer rejected the re-rate and wants a re-measure'
        : `${formatMoney(money(adjustment.difference))} sent to the customer, no reply yet`,
      waiting: waitingFor(adjustment.raisedAt),
      waitingHours: hoursSince(adjustment.raisedAt),
      action: declined
        ? { label: 'Re-measure', permission: null, href: null }
        : { label: 'Review', permission: 'adjustments:read', href: `/admin/billing` },
    });
  }

  // A walk-in can reach Labelled on four fields and stops dead there — no
  // container accepts a piece without a full consignee.
  const blocked = await bookings()
    .find({ 'receiver.line1': { $in: [null, ''] } })
    .limit(20)
    .toArray();

  for (const booking of blocked) {
    out.push({
      id: `blocked-${booking.reference}`,
      type: 'Blocked',
      tone: 'alert',
      reference: booking.reference,
      what: 'Walk-in has no receiver address — cannot load or clear customs',
      waiting: waitingFor(booking.createdAt),
      waitingHours: hoursSince(booking.createdAt),
      action: { label: 'Resend link', permission: null, href: null },
    });
  }

  const failedMessages = await notifications()
    .find({ status: 'failed' })
    .limit(20)
    .toArray();

  for (const message of failedMessages) {
    out.push({
      id: `notify-${String(message._id)}`,
      type: 'Notify',
      tone: 'warn',
      reference: String(message.entityRef ?? '—'),
      what: 'Message bounced — the customer has never seen the price change',
      waiting: waitingFor(new Date(String(message.createdAt))),
      waitingHours: hoursSince(new Date(String(message.createdAt))),
      action: { label: 'Fix number', permission: null, href: null },
    });
  }

  const overdue = await invoices()
    .find({ status: 'sent', dueAt: { $lt: new Date() } })
    .limit(20)
    .toArray();

  for (const invoice of overdue) {
    out.push({
      id: `invoice-${String(invoice.number)}`,
      type: 'Overdue',
      tone: 'muted',
      reference: String(invoice.number),
      what: `${formatMoney(money(Number(invoice.total ?? 0)))} unpaid`,
      waiting: waitingFor(new Date(String(invoice.dueAt))),
      waitingHours: hoursSince(new Date(String(invoice.dueAt))),
      action: { label: 'Open invoice', permission: null, href: null },
    });
  }

  return out.sort((a, b) => b.waitingHours - a.waitingHours);
};

export const buildOverview = async () => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [bookedToday, awaitingCheck, openAdjustments, exceptions] = await Promise.all([
    bookings().countDocuments({ createdAt: { $gte: startOfToday } }),
    pieces().countDocuments({ status: { $in: ['received', 'booked'] } }),
    adjustments().find({ state: 'awaiting_approval' }).toArray(),
    buildExceptions(),
  ]);

  const heldValue = openAdjustments.reduce((sum, a) => sum + a.difference, 0);

  return {
    kpis: {
      bookedToday,
      awaitingCheck,
      unapprovedRerates: openAdjustments.length,
      heldValue: formatMinor(heldValue),
      heldValueDisplay: formatMoney(money(heldValue)),
    },
    exceptions,
  };
};

/**
 * Settle an adjustment.
 *
 * Every path through here records who did it and why. An override on a
 * customer's behalf is legitimate — they phone in, they cannot get online —
 * but it must never be indistinguishable from the customer having clicked the
 * button themselves.
 */
export const settleAdjustment = async (
  reference: string,
  outcome: 'approved' | 'waived',
  actor: StaffDoc,
  reason: string,
): Promise<AdjustmentDoc> => {
  const adjustment = await adjustments().findOne({ reference });
  if (!adjustment) throw new AppError(`No adjustment ${reference}`, 'adjustment_not_found', 404);

  if (adjustment.state !== 'awaiting_approval' && adjustment.state !== 'declined') {
    throw new AppError(
      `${reference} is already ${adjustment.state.replace('_', ' ')}`,
      'adjustment_already_settled',
      409,
    );
  }

  const now = new Date();
  // Piece status, adjustment state and the audit event move together or not
  // at all. A piece released for loading with no record of who released it is
  // the failure this transaction exists to prevent.
  await withTransaction(async (session) => {
    await adjustments().updateOne(
      { _id: adjustment._id },
      {
        $set: {
          state: outcome,
          settledAt: now,
          settledBy: actor.email,
          settledReason: reason,
        },
      },
      { session },
    );

    await pieces().updateMany(
      { bookingId: adjustment.bookingId, status: 'rerate_held' },
      { $set: { status: 'verified' } },
      { session },
    );

    await bookings().updateOne(
      { _id: adjustment.bookingId },
      { $set: { status: 'verified', updatedAt: now } },
      { session },
    );
  });

  const affected = await pieces().find({ bookingId: adjustment.bookingId }).toArray();
  await events().insertMany(
    affected.map((piece) => ({
      at: now,
      pieceId: piece.trackingId ?? String(piece._id),
      bookingRef: adjustment.bookingRef,
      code: 'approved' as const,
      actor: `${actor.name} (${actor.role})`,
      detail:
        outcome === 'waived'
          ? `Difference of ${formatMoney(money(adjustment.difference))} waived — ${reason}`
          : `Approved on the customer's behalf by staff — ${reason}`,
    })),
  );

  return { ...adjustment, state: outcome, settledAt: now };
};

/** Queue another attempt at telling the customer. Idempotent by construction. */
export const remindAboutAdjustment = async (
  reference: string,
  actor: StaffDoc,
): Promise<{ queued: boolean; channel: string }> => {
  const adjustment = await adjustments().findOne({ reference });
  if (!adjustment) throw new AppError(`No adjustment ${reference}`, 'adjustment_not_found', 404);

  if (adjustment.state !== 'awaiting_approval') {
    throw new AppError('That adjustment is not waiting on anyone', 'adjustment_not_open', 409);
  }

  const attempt = Date.now();
  await notifications().insertOne({
    entityId: String(adjustment._id),
    entityRef: adjustment.bookingRef,
    // The idempotency key includes the attempt, so a deliberate reminder is
    // allowed while a retried worker still cannot double-send.
    event: `adjustment.reminder.${attempt}`,
    channel: 'sms',
    status: 'queued',
    to: adjustment.bookingRef,
    body: `Reminder: price change on ${adjustment.bookingRef}. Approve at cf.lk/a/${adjustment.bookingRef}`,
    requestedBy: actor.email,
    createdAt: new Date(),
  });

  return { queued: true, channel: 'sms' };
};

export const listBookings = async (limit = 50) => {
  const rows = await bookings().find({}).sort({ createdAt: -1 }).limit(limit).toArray();

  return Promise.all(
    rows.map(async (booking) => {
      const count = await pieces().countDocuments({ bookingId: booking._id! });
      return {
        reference: booking.reference,
        customerName: booking.customerName,
        lane: booking.lane,
        service: booking.service,
        status: booking.status,
        pieceCount: count,
        bookedTotal: formatMinor(booking.bookedQuote.total.amount),
        currentTotal: formatMinor(
          (booking.verifiedQuote ?? booking.bookedQuote).total.amount,
        ),
        createdAt: booking.createdAt.toISOString(),
      };
    }),
  );
};

export const findAdjustments = async () => {
  const rows = await adjustments().find({}).sort({ raisedAt: -1 }).limit(100).toArray();
  return rows.map((a) => ({
    reference: a.reference,
    bookingRef: a.bookingRef,
    state: a.state,
    bookedTotal: formatMinor(a.bookedTotal),
    verifiedTotal: formatMinor(a.verifiedTotal),
    difference: formatMinor(a.difference),
    differenceDisplay: formatMoney(money(a.difference)),
    differencePercent: (a.differenceBasisPoints / 100).toFixed(1),
    raisedAt: a.raisedAt.toISOString(),
    raisedBy: a.raisedBy,
    waiting: waitingFor(a.raisedAt),
    autoApproveAt: a.autoApproveAt?.toISOString() ?? null,
    changedPieceIndexes: a.changedPieceIndexes,
  }));
};

export const objectId = (value: string): ObjectId => new ObjectId(value);
