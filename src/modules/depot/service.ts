import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { COLLECTIONS, collection, withTransaction } from '../../db/mongo.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { formatMinor, formatMoney, formatVolume, volumeOf } from '../../shared/units.js';
import * as notifications from '../notifications/service.js';
import { assessRerate, priceShipment } from '../pricing/engine.js';
import { getActiveRateCard } from '../pricing/repository.js';
import { LANES } from '../pricing/rate-cards.js';
import { PackagingKind, type PieceInput, type QuoteRequest } from '../pricing/types.js';
import { nextAdjustmentReference, trackingIdFor } from '../shipments/sequences.js';
import {
  deriveBookingStatus,
  type AdjustmentDoc,
  type BookingDoc,
  type ContainerDoc,
  type Measurement,
  type PieceDoc,
  type PieceEventDoc,
} from '../shipments/types.js';
import { code128 } from './barcode.js';

const bookings = () => collection<BookingDoc>(COLLECTIONS.bookings);
const pieces = () => collection<PieceDoc>(COLLECTIONS.pieces);
const adjustments = () => collection<AdjustmentDoc>(COLLECTIONS.adjustments);
const events = () => collection<PieceEventDoc>(COLLECTIONS.pieceEvents);

export interface Actor {
  name: string;
  workstation: string;
}

const measurementOf = (
  lengthMm: number,
  widthMm: number,
  heightMm: number,
  weightGrams: number,
): Measurement => ({
  lengthMm,
  widthMm,
  heightMm,
  weightGrams,
  volume: volumeOf(lengthMm, widthMm, heightMm),
});

const asPieceInput = (piece: PieceDoc, measurement: Measurement): PieceInput => ({
  packaging: piece.packaging,
  lengthMm: measurement.lengthMm,
  widthMm: measurement.widthMm,
  heightMm: measurement.heightMm,
  weightGrams: measurement.weightGrams,
});

/**
 * Price the booking as it currently physically stands: measured figures for
 * every piece the depot has been through, the customer's own figures for the
 * rest.
 *
 * The alternative — waiting until every piece is measured before repricing —
 * would mean a customer whose first box is double the declared size hears
 * nothing until the last box lands, which may be days. Repricing per piece
 * means the conversation starts at the first surprise.
 */
const currentQuoteRequest = (booking: BookingDoc, all: PieceDoc[]): QuoteRequest => ({
  lane: booking.lane,
  service: booking.service,
  pieces: all
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((piece) => asPieceInput(piece, piece.verified ?? piece.declared)),
});

// ── 2.1 Receiving ──────────────────────────────────────────────────────────

export const ReceiveInput = z.object({
  /** Omit to receive the whole booking; pass sequences for a partial delivery. */
  sequences: z.array(z.number().int().positive()).optional(),
  depotId: z.string().trim().min(2).max(24).default('WS-03'),
});

export interface ReceivedPiece {
  sequence: number;
  trackingId: string;
  packaging: string;
  declared: { dimensionsCm: string; weightKg: string };
}

/**
 * Requirement 2.1: tracking IDs are minted here, on physical receipt, and
 * nowhere else.
 *
 * Issuing them at booking time would be easier and wrong — the system would
 * hold live tracking IDs for boxes that never arrive, customers would ring
 * about numbers that scan to nothing, and the count of pieces in the warehouse
 * would be a count of pieces someone once intended to send.
 *
 * Receiving is idempotent per piece: a box already received keeps the ID
 * already printed on its label. Re-scanning a pallet is a normal thing to do,
 * not an error.
 */
export const receiveBooking = async (
  reference: string,
  input: z.infer<typeof ReceiveInput>,
  actor: Actor,
): Promise<{ reference: string; received: ReceivedPiece[]; alreadyReceived: ReceivedPiece[] }> => {
  const booking = await bookings().findOne({ reference: reference.toUpperCase() });
  if (!booking) throw notFound(`Booking ${reference}`, 'booking_not_found');

  const all = await pieces().find({ bookingId: booking._id! }).sort({ sequence: 1 }).toArray();
  if (all.length === 0) throw notFound(`Pieces for ${reference}`, 'pieces_not_found');

  const wanted = input.sequences?.length
    ? all.filter((piece) => input.sequences!.includes(piece.sequence))
    : all;

  if (wanted.length === 0) {
    throw badRequest('None of those piece numbers belong to this booking', 'unknown_sequences');
  }

  const present = (piece: PieceDoc, trackingId: string): ReceivedPiece => ({
    sequence: piece.sequence,
    trackingId,
    packaging: piece.packaging,
    declared: {
      dimensionsCm: `${piece.declared.lengthMm / 10} × ${piece.declared.widthMm / 10} × ${
        piece.declared.heightMm / 10
      }`,
      weightKg: (piece.declared.weightGrams / 1000).toFixed(1),
    },
  });

  const alreadyReceived = wanted
    .filter((piece) => piece.trackingId)
    .map((piece) => present(piece, piece.trackingId!));

  const toReceive = wanted.filter((piece) => !piece.trackingId);
  const received: ReceivedPiece[] = [];
  const now = new Date();

  if (toReceive.length > 0) {
    await withTransaction(async (session) => {
      const eventDocs: PieceEventDoc[] = [];

      for (const piece of toReceive) {
        const trackingId = trackingIdFor(booking.reference, piece.sequence);
        await pieces().updateOne(
          { _id: piece._id! },
          {
            $set: {
              trackingId,
              status: 'received',
              depotId: input.depotId,
              receivedAt: now,
            },
          },
          { session },
        );
        received.push(present(piece, trackingId));
        eventDocs.push({
          at: now,
          pieceId: trackingId,
          bookingRef: booking.reference,
          code: 'received',
          actor: actor.name,
          workstation: actor.workstation,
          detail: `Received at ${input.depotId}, tracking ID issued`,
        });
      }

      await events().insertMany(eventDocs, { session });

      const after = await pieces().find({ bookingId: booking._id! }, { session }).toArray();
      await bookings().updateOne(
        { _id: booking._id! },
        { $set: { status: deriveBookingStatus(after), updatedAt: now } },
        { session },
      );
    });

    await notifications.send({
      entityId: `${booking.reference}:received:${received.length}`,
      event: 'received_at_depot',
      bookingRef: booking.reference,
      to: { email: booking.sender.email, mobile: booking.sender.mobile },
      data: {
        customerName: booking.customerName,
        bookingRef: booking.reference,
        receivedCount: received.length,
        trackingIds: received
          .map((piece) => `  ${piece.trackingId} — ${piece.packaging.replace(/_/g, ' ')}`)
          .join(String.fromCharCode(10)),
      },
    });
  }

  return { reference: booking.reference, received, alreadyReceived };
};

// ── 2.1 / 2.2 Verification and re-rating ───────────────────────────────────

export const VerifyInput = z.object({
  lengthMm: z.number().int().positive().max(3_000),
  widthMm: z.number().int().positive().max(3_000),
  heightMm: z.number().int().positive().max(3_000),
  weightGrams: z.number().int().positive().max(1_000_000),
});

export interface VerifyResult {
  trackingId: string;
  bookingRef: string;
  status: string;
  matchedDeclared: boolean;
  measured: { dimensionsCm: string; weightKg: string; volume: string };
  declared: { dimensionsCm: string; weightKg: string; volume: string };
  rerate: {
    outcome: string;
    bookedTotal: string;
    verifiedTotal: string;
    difference: string;
    differencePercent: string;
    tolerance: string;
    adjustmentReference: string | null;
    customerNotified: boolean;
    message: string;
  };
  /** True while pieces still await the scale — the price can move again. */
  provisional: boolean;
}

/**
 * Requirement 2.1 (validation of physical against submitted) and 2.2 (dynamic
 * recalculation), which are one operation: the operator puts the box on the
 * scale, and the money consequence appears on the same screen.
 *
 * The operator is never asked to decide anything about the price. They record
 * what the scale says; the engine decides whether that is within tolerance,
 * needs the customer's approval, or is far enough out to stop the shipment.
 * Separating measurement from pricing authority is a fraud control.
 */
export const verifyPiece = async (
  trackingId: string,
  input: z.infer<typeof VerifyInput>,
  actor: Actor,
): Promise<VerifyResult> => {
  const piece = await pieces().findOne({ trackingId: trackingId.toUpperCase() });
  if (!piece) throw notFound(`Tracking ID ${trackingId}`, 'piece_not_found');
  if (!piece.receivedAt) {
    throw conflict(`${trackingId} has not been received yet`, 'piece_not_received');
  }
  if (piece.containerId) {
    throw conflict(`${trackingId} is already loaded and cannot be re-measured`, 'piece_loaded');
  }

  const booking = await bookings().findOne({ _id: piece.bookingId });
  if (!booking) throw notFound(`Booking for ${trackingId}`, 'booking_not_found');

  const card = await getActiveRateCard();
  const now = new Date();
  const measured = measurementOf(input.lengthMm, input.widthMm, input.heightMm, input.weightGrams);

  const all = await pieces().find({ bookingId: booking._id! }).toArray();
  const withThisOne = all.map((p) =>
    p._id!.equals(piece._id!) ? { ...p, verified: measured } : p,
  );

  const bookedQuote = booking.bookedQuote;
  const verifiedQuote = priceShipment(currentQuoteRequest(booking, withThisOne), card, now);
  const assessment = assessRerate(bookedQuote, verifiedQuote, card, now);

  const matchedDeclared =
    measured.lengthMm === piece.declared.lengthMm &&
    measured.widthMm === piece.declared.widthMm &&
    measured.heightMm === piece.declared.heightMm &&
    measured.weightGrams === piece.declared.weightGrams;

  // Only an unapproved increase holds the piece. A shipment does not stop
  // moving because it turned out to be cheaper.
  const holds = assessment.outcome === 'approval_required' || assessment.outcome === 'hard_stop';
  const pieceStatus = holds ? 'rerate_held' : 'verified';

  let adjustmentReference: string | null = null;
  const existing = await adjustments().findOne({
    bookingId: booking._id!,
    state: 'awaiting_approval',
  });

  await withTransaction(async (session) => {
      await pieces().updateOne(
        { _id: piece._id! },
        { $set: { verified: measured, status: pieceStatus, verifiedAt: now } },
        { session },
      );

      await events().insertOne(
        {
          at: now,
          pieceId: piece.trackingId!,
          bookingRef: booking.reference,
          code: 'measured',
          actor: actor.name,
          workstation: actor.workstation,
          detail: matchedDeclared
            ? `Measured as declared: ${measured.lengthMm / 10}×${measured.widthMm / 10}×${
                measured.heightMm / 10
              } cm, ${(measured.weightGrams / 1000).toFixed(1)} kg`
            : `Measured ${measured.lengthMm / 10}×${measured.widthMm / 10}×${
                measured.heightMm / 10
              } cm, ${(measured.weightGrams / 1000).toFixed(1)} kg — declared ${
                piece.declared.lengthMm / 10
              }×${piece.declared.widthMm / 10}×${piece.declared.heightMm / 10} cm, ${(
                piece.declared.weightGrams / 1000
              ).toFixed(1)} kg`,
        },
        { session },
      );

      if (holds) {
        // One open adjustment per booking. A second oversized box revises the
        // figure the customer is looking at rather than starting a second
        // conversation about the same shipment.
        if (existing) {
          adjustmentReference = existing.reference;
          await adjustments().updateOne(
            { _id: existing._id! },
            {
              $set: {
                verifiedTotal: assessment.verified.total.amount,
                difference: assessment.difference.amount,
                differenceBasisPoints: assessment.differenceBasisPoints,
                toleranceApplied: assessment.toleranceApplied.amount,
                changedPieceIndexes: assessment.changedPieceIndexes,
                autoApproveAt: assessment.autoApproveAt,
              },
            },
            { session },
          );
        } else {
          adjustmentReference = await nextAdjustmentReference(now);
          await adjustments().insertOne(
            {
              reference: adjustmentReference,
              bookingId: booking._id!,
              bookingRef: booking.reference,
              state: 'awaiting_approval',
              bookedTotal: assessment.booked.total.amount,
              verifiedTotal: assessment.verified.total.amount,
              difference: assessment.difference.amount,
              differenceBasisPoints: assessment.differenceBasisPoints,
              toleranceApplied: assessment.toleranceApplied.amount,
              changedPieceIndexes: assessment.changedPieceIndexes,
              raisedAt: now,
              raisedBy: actor.name,
              autoApproveAt: assessment.autoApproveAt,
              settledAt: null,
            },
            { session },
          );
        }

        await events().insertOne(
          {
            at: now,
            pieceId: piece.trackingId!,
            bookingRef: booking.reference,
            code: 'rerated',
            actor: actor.name,
            workstation: actor.workstation,
            detail: `${adjustmentReference}: ${formatMoney(assessment.booked.total)} → ${formatMoney(
              assessment.verified.total,
            )}`,
          },
          { session },
        );
      }

      const after = await pieces().find({ bookingId: booking._id! }, { session }).toArray();
      await bookings().updateOne(
        { _id: booking._id! },
        {
          $set: {
            verifiedQuote,
            status: deriveBookingStatus(after),
            updatedAt: now,
          },
        },
        { session },
      );
    });

  // Requirement 3.1: real-time notification of a price adjustment. Only when
  // the adjustment is new — a revised figure on an open adjustment reaches the
  // customer through the same tracking link they were already sent.
  let customerNotified = false;
  if (holds && adjustmentReference && !existing) {
    await notifications.send({
      entityId: adjustmentReference,
      event: 'price_changed',
      bookingRef: booking.reference,
      to: { email: booking.sender.email, mobile: booking.sender.mobile },
      data: {
        customerName: booking.customerName,
        bookingRef: booking.reference,
        bookedTotal: formatMoney(assessment.booked.total),
        verifiedTotal: formatMoney(assessment.verified.total),
        difference: formatMoney(assessment.difference),
        differencePercent: (assessment.differenceBasisPoints / 100).toFixed(1),
        changedCount: assessment.changedPieceIndexes.length,
        autoApproveAt: assessment.autoApproveAt?.toDateString() ?? undefined,
      },
    });
    customerNotified = true;
  }

  const messages: Record<string, string> = {
    unchanged: 'Measured exactly as booked. Nothing to do.',
    absorbed: `Within tolerance (${formatMinor(
      assessment.toleranceApplied.amount,
    )}). Absorbed — the customer is not disturbed.`,
    approval_required: `Over tolerance. ${adjustmentReference} raised and the customer notified. This piece is held.`,
    hard_stop: `Far outside tolerance. ${adjustmentReference} raised — a supervisor must look at this shipment.`,
    refund: 'Measured smaller than booked. The customer is owed the difference.',
  };

  const stillWaiting = withThisOne.some((p) => !p.verified);

  return {
    trackingId: piece.trackingId!,
    bookingRef: booking.reference,
    status: pieceStatus,
    matchedDeclared,
    measured: {
      dimensionsCm: `${measured.lengthMm / 10} × ${measured.widthMm / 10} × ${measured.heightMm / 10}`,
      weightKg: (measured.weightGrams / 1000).toFixed(1),
      volume: formatVolume(measured.volume),
    },
    declared: {
      dimensionsCm: `${piece.declared.lengthMm / 10} × ${piece.declared.widthMm / 10} × ${
        piece.declared.heightMm / 10
      }`,
      weightKg: (piece.declared.weightGrams / 1000).toFixed(1),
      volume: formatVolume(piece.declared.volume),
    },
    rerate: {
      outcome: assessment.outcome,
      bookedTotal: formatMoney(assessment.booked.total),
      verifiedTotal: formatMoney(assessment.verified.total),
      difference: formatMoney(assessment.difference),
      differencePercent: (assessment.differenceBasisPoints / 100).toFixed(1),
      tolerance: formatMinor(assessment.toleranceApplied.amount),
      adjustmentReference,
      customerNotified,
      message: messages[assessment.outcome] ?? assessment.outcome,
    },
    provisional: stillWaiting,
  };
};

// ── 2.2 Labels ─────────────────────────────────────────────────────────────

export interface Label {
  trackingId: string;
  bookingRef: string;
  sequence: number;
  pieceCount: number;
  consignee: string;
  destination: string;
  receiver: BookingDoc['receiver'];
  sender: BookingDoc['sender'];
  service: string;
  lane: string;
  route: string;
  packaging: string;
  measurement: { dimensionsCm: string; weightKg: string; volume: string; source: string };
  barcodeSvg: string;
  printedAt: string;
}

/**
 * Requirement 2.2. The label carries the measured figures where we have them,
 * because the label is what the destination warehouse reads when the box
 * arrives and a label disagreeing with the box is worse than no label.
 */
export const labelFor = async (trackingId: string): Promise<Label> => {
  const piece = await pieces().findOne({ trackingId: trackingId.toUpperCase() });
  if (!piece) throw notFound(`Tracking ID ${trackingId}`, 'piece_not_found');

  const booking = await bookings().findOne({ _id: piece.bookingId });
  if (!booking) throw notFound(`Booking for ${trackingId}`, 'booking_not_found');

  const count = await pieces().countDocuments({ bookingId: booking._id! });
  const lane = LANES.find((l) => l.code === booking.lane);
  const source = piece.verified ?? piece.declared;

  return {
    trackingId: piece.trackingId!,
    bookingRef: booking.reference,
    sequence: piece.sequence,
    pieceCount: count,
    consignee: piece.consigneeName,
    destination: piece.destination,
    receiver: booking.receiver,
    sender: booking.sender,
    service: booking.service === 'sea_lcl' ? 'SEA LCL' : 'AIR EXPRESS',
    lane: booking.lane,
    route: lane ? `${lane.from} → ${lane.to}` : booking.lane,
    packaging: piece.packaging.replace(/_/g, ' '),
    measurement: {
      dimensionsCm: `${source.lengthMm / 10} × ${source.widthMm / 10} × ${source.heightMm / 10}`,
      weightKg: (source.weightGrams / 1000).toFixed(1),
      volume: formatVolume(source.volume),
      source: piece.verified ? 'measured' : 'declared',
    },
    barcodeSvg: code128(piece.trackingId!, { moduleWidth: 2, height: 76 }).svg,
    printedAt: new Date().toISOString(),
  };
};

/** Mark labels printed, so the loading board knows what is ready to go. */
export const markLabelled = async (trackingIds: string[], actor: Actor): Promise<number> => {
  const ids = trackingIds.map((id) => id.toUpperCase());
  const found = await pieces()
    .find({ trackingId: { $in: ids }, status: { $in: ['verified', 'labelled'] } })
    .toArray();

  if (found.length === 0) {
    throw badRequest(
      'None of those pieces are checked and ready to label',
      'nothing_to_label',
    );
  }

  const now = new Date();
  await pieces().updateMany(
    { _id: { $in: found.map((p) => p._id!) } },
    { $set: { status: 'labelled' } },
  );
  await events().insertMany(
    found.map((piece) => ({
      at: now,
      pieceId: piece.trackingId!,
      bookingRef: piece.bookingRef,
      code: 'labelled' as const,
      actor: actor.name,
      workstation: actor.workstation,
      detail: 'Shipping label printed',
    })),
  );

  for (const bookingId of new Set(found.map((p) => p.bookingId.toHexString()))) {
    const id = new ObjectId(bookingId);
    const after = await pieces().find({ bookingId: id }).toArray();
    await bookings().updateOne(
      { _id: id },
      { $set: { status: deriveBookingStatus(after), updatedAt: now } },
    );
  }

  return found.length;
};

// ── 2.1 Walk-in express intake ─────────────────────────────────────────────

export const WalkInInput = z.object({
  lane: z.string().min(3),
  service: z.enum(['sea_lcl', 'air_express']).default('sea_lcl'),
  senderName: z.string().trim().min(2).max(120),
  senderMobile: z.string().trim().min(7).max(20),
  receiverName: z.string().trim().min(2).max(120),
  receiverMobile: z.string().trim().min(7).max(20),
  receiverCity: z.string().trim().min(2).max(80),
  pieces: z
    .array(
      z.object({
        packaging: PackagingKind.default('custom_carton'),
        lengthMm: z.number().int().positive().max(3_000),
        widthMm: z.number().int().positive().max(3_000),
        heightMm: z.number().int().positive().max(3_000),
        weightGrams: z.number().int().positive().max(1_000_000),
      }),
    )
    .min(1)
    .max(60),
  depotId: z.string().trim().min(2).max(24).default('WS-03'),
});

/**
 * Requirement 2.1: walk-in intake with minimal data.
 *
 * Someone is standing at the counter with boxes. Asking for a full address at
 * that moment means a queue, so this takes the least that still produces a
 * legal, deliverable shipment: who is sending, who is receiving, a contact
 * number for each, the destination city, and the real measurements — which are
 * available because the boxes are right there.
 *
 * Because the box is measured at intake, declared and verified are the same
 * figures and there is nothing to re-rate. The full address is completed later
 * from the booking reference; the address fields carry an explicit marker
 * rather than an empty string, so nothing downstream mistakes an incomplete
 * address for a blank one.
 */
export const walkIn = async (
  input: z.infer<typeof WalkInInput>,
  actor: Actor,
): Promise<{
  reference: string;
  total: string;
  pieces: { trackingId: string; dimensionsCm: string; weightKg: string }[];
  needsAddress: true;
}> => {
  const lane = LANES.find((l) => l.code === input.lane);
  if (!lane) throw badRequest(`We do not ship ${input.lane}`, 'unknown_lane');

  const card = await getActiveRateCard();
  const now = new Date();
  const { nextBookingReference } = await import('../shipments/sequences.js');
  const reference = await nextBookingReference(now);

  const quote = priceShipment(
    {
      lane: input.lane,
      service: input.service,
      pieces: input.pieces,
    },
    card,
    now,
  );

  const bookingId = new ObjectId();
  const AWAITING = 'TO BE COMPLETED';

  const booking: BookingDoc = {
    _id: bookingId,
    reference,
    customerRef: 'WALK-IN',
    customerName: input.senderName,
    lane: input.lane,
    service: input.service,
    sender: {
      name: input.senderName,
      mobile: input.senderMobile.replace(/[ ()-]/g, ''),
      line1: AWAITING,
      city: lane.from,
      postcode: AWAITING,
      country: lane.fromCountry,
    },
    receiver: {
      name: input.receiverName,
      mobile: input.receiverMobile.replace(/[ ()-]/g, ''),
      line1: AWAITING,
      city: input.receiverCity,
      postcode: AWAITING,
      country: lane.toCountry,
    },
    status: 'verified',
    bookedQuote: quote,
    verifiedQuote: quote,
    createdAt: now,
    updatedAt: now,
  };

  const pieceDocs: PieceDoc[] = input.pieces.map((piece, index) => {
    const measurement = measurementOf(
      piece.lengthMm,
      piece.widthMm,
      piece.heightMm,
      piece.weightGrams,
    );
    return {
      bookingId,
      bookingRef: reference,
      consigneeName: input.receiverName,
      destination: `${input.receiverCity}, ${lane.toCountry}`,
      trackingId: trackingIdFor(reference, index + 1),
      sequence: index + 1,
      packaging: piece.packaging,
      declared: measurement,
      verified: measurement,
      status: 'verified',
      depotId: input.depotId,
      containerId: null,
      receivedAt: now,
      verifiedAt: now,
      createdAt: now,
    };
  });

  await withTransaction(async (session) => {
      await bookings().insertOne(booking, { session });
      await pieces().insertMany(pieceDocs, { session });
      await events().insertMany(
        pieceDocs.flatMap((piece) => [
          {
            at: now,
            pieceId: piece.trackingId!,
            bookingRef: reference,
            code: 'received' as const,
            actor: actor.name,
            workstation: actor.workstation,
            detail: `Walk-in intake at ${input.depotId}`,
          },
          {
            at: now,
            pieceId: piece.trackingId!,
            bookingRef: reference,
            code: 'measured' as const,
            actor: actor.name,
            workstation: actor.workstation,
            detail: `Measured on intake: ${piece.declared.lengthMm / 10}×${
              piece.declared.widthMm / 10
            }×${piece.declared.heightMm / 10} cm, ${(piece.declared.weightGrams / 1000).toFixed(1)} kg`,
          },
        ]),
        { session },
      );
    });

  return {
    reference,
    total: formatMoney(quote.total),
    pieces: pieceDocs.map((piece) => ({
      trackingId: piece.trackingId!,
      dimensionsCm: `${piece.declared.lengthMm / 10} × ${piece.declared.widthMm / 10} × ${
        piece.declared.heightMm / 10
      }`,
      weightKg: (piece.declared.weightGrams / 1000).toFixed(1),
    })),
    needsAddress: true,
  };
};

// ── The bench's own view ───────────────────────────────────────────────────

export interface QueueEntry {
  bookingRef: string;
  customerName: string;
  route: string;
  service: string;
  pieceCount: number;
  awaitingReceipt: number;
  awaitingMeasure: number;
  held: number;
  readyToLabel: number;
  bookedTotal: string;
  bookedAt: string;
}

/** What is on the floor right now, ordered oldest first — that is the queue. */
export const depotQueue = async (): Promise<{ entries: QueueEntry[] }> => {
  const open = await bookings()
    .find({ status: { $nin: ['in_transit', 'delivered', 'cleared'] } })
    .sort({ createdAt: 1 })
    .limit(60)
    .toArray();

  const entries: QueueEntry[] = [];

  for (const booking of open) {
    const all = await pieces().find({ bookingId: booking._id! }).toArray();
    const lane = LANES.find((l) => l.code === booking.lane);

    entries.push({
      bookingRef: booking.reference,
      customerName: booking.customerName,
      route: lane ? `${lane.from} → ${lane.to}` : booking.lane,
      service: booking.service === 'sea_lcl' ? 'Sea' : 'Air',
      pieceCount: all.length,
      awaitingReceipt: all.filter((p) => !p.receivedAt).length,
      awaitingMeasure: all.filter((p) => p.receivedAt && !p.verified).length,
      held: all.filter((p) => p.status === 'rerate_held').length,
      readyToLabel: all.filter((p) => p.status === 'verified').length,
      bookedTotal: formatMinor(booking.bookedQuote.total.amount),
      bookedAt: booking.createdAt.toISOString(),
    });
  }

  return { entries };
};

/** Everything the bench needs about one box, from a single scan. */
export const lookupPiece = async (trackingId: string) => {
  const piece = await pieces().findOne({ trackingId: trackingId.toUpperCase() });
  if (!piece) throw notFound(`Tracking ID ${trackingId}`, 'piece_not_found');

  const booking = await bookings().findOne({ _id: piece.bookingId });
  if (!booking) throw notFound(`Booking for ${trackingId}`, 'booking_not_found');

  const lane = LANES.find((l) => l.code === booking.lane);

  return {
    trackingId: piece.trackingId,
    bookingRef: booking.reference,
    customerName: booking.customerName,
    consignee: piece.consigneeName,
    route: lane ? `${lane.from} → ${lane.to}` : booking.lane,
    sequence: piece.sequence,
    packaging: piece.packaging,
    status: piece.status,
    declared: {
      lengthCm: piece.declared.lengthMm / 10,
      widthCm: piece.declared.widthMm / 10,
      heightCm: piece.declared.heightMm / 10,
      weightKg: piece.declared.weightGrams / 1000,
      volume: formatVolume(piece.declared.volume),
    },
    verified: piece.verified
      ? {
          lengthCm: piece.verified.lengthMm / 10,
          widthCm: piece.verified.widthMm / 10,
          heightCm: piece.verified.heightMm / 10,
          weightKg: piece.verified.weightGrams / 1000,
          volume: formatVolume(piece.verified.volume),
        }
      : null,
    receivedAt: piece.receivedAt?.toISOString() ?? null,
    verifiedAt: piece.verifiedAt?.toISOString() ?? null,
    loaded: Boolean(piece.containerId),
  };
};

// ── The warehouse dashboard ────────────────────────────────────────────────

export interface DepotOverview {
  counts: {
    awaitingReceipt: number;
    awaitingMeasure: number;
    held: number;
    readyToLabel: number;
    loadedToday: number;
  };
  /** Containers still taking boxes, soonest cut-off first. */
  openContainers: {
    containerNumber: string;
    destination: string;
    vessel: string;
    voyage: string;
    fillPercent: number;
    pieceCount: number;
    cutOffAt: string;
    hoursToCutOff: number;
  }[];
  /** Boxes measured over tolerance and waiting on a decision. */
  heldPieces: {
    trackingId: string;
    bookingRef: string;
    consignee: string;
    declaredVolume: string;
    verifiedVolume: string;
  }[];
  recentEvents: { at: string; pieceId: string; code: string; actor: string; detail: string }[];
}

/**
 * What one operator needs to know before touching anything: how much work is
 * waiting, in which stage, and which container is closest to its cut-off.
 *
 * Counted with aggregations rather than by loading every piece, because this is
 * the first screen of a shift and a warehouse with ten thousand boxes on the
 * floor should not make somebody wait for it.
 */
export const depotOverview = async (): Promise<DepotOverview> => {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const [byStatus] = await Promise.all([
    pieces()
      .aggregate<{ _id: string; n: number }>([
        { $match: { status: { $nin: ['in_transit', 'delivered', 'cleared'] } } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ])
      .toArray(),
  ]);

  const count = (status: string) => byStatus.find((row) => row._id === status)?.n ?? 0;

  const loadedToday = await collection<PieceEventDoc>(COLLECTIONS.pieceEvents).countDocuments({
    code: 'loaded',
    at: { $gte: startOfDay },
  });

  const containerDocs = await collection<ContainerDoc>(COLLECTIONS.containers)
    .find({ status: 'open' })
    .sort({ cutOffAt: 1 })
    .limit(6)
    .toArray();

  const openContainers = [];
  for (const container of containerDocs) {
    const loaded = await pieces().find({ containerId: container._id! }).toArray();
    const used = loaded.reduce((total, p) => total + (p.verified ?? p.declared).volume, 0);
    openContainers.push({
      containerNumber: container.containerNumber,
      destination: container.destinationLabel,
      vessel: container.vessel,
      voyage: container.voyage,
      fillPercent:
        container.capacityVolume === 0 ? 0 : Math.round((used / container.capacityVolume) * 100),
      pieceCount: loaded.length,
      cutOffAt: container.cutOffAt.toISOString(),
      hoursToCutOff: Math.round((container.cutOffAt.getTime() - now.getTime()) / 3_600_000),
    });
  }

  const held = await pieces().find({ status: 'rerate_held' }).limit(12).toArray();

  const recentEvents = await collection<PieceEventDoc>(COLLECTIONS.pieceEvents)
    .find({})
    .sort({ at: -1 })
    .limit(8)
    .toArray();

  return {
    counts: {
      awaitingReceipt: count('booked'),
      awaitingMeasure: count('received'),
      held: count('rerate_held'),
      readyToLabel: count('verified') + count('labelled'),
      loadedToday,
    },
    openContainers,
    heldPieces: held.map((piece) => ({
      trackingId: piece.trackingId ?? '—',
      bookingRef: piece.bookingRef,
      consignee: piece.consigneeName,
      declaredVolume: formatVolume(piece.declared.volume),
      verifiedVolume: piece.verified ? formatVolume(piece.verified.volume) : '—',
    })),
    recentEvents: recentEvents.map((event) => ({
      at: event.at.toISOString(),
      pieceId: event.pieceId,
      code: event.code,
      actor: event.actor,
      detail: event.detail,
    })),
  };
};
