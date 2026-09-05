import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { COLLECTIONS, collection, withTransaction } from '../../db/mongo.js';
import { badRequest } from '../../shared/errors.js';
import { formatMoney, volumeOf } from '../../shared/units.js';
import { priceShipment, PricingError } from '../pricing/engine.js';
import { getActiveRateCard } from '../pricing/repository.js';
import { LANES, normaliseDeclared } from '../pricing/rate-cards.js';
import { PieceInput, ServiceMode, type QuoteRequest } from '../pricing/types.js';
import * as notifications from '../notifications/service.js';
import { rememberSender } from '../customers/service.js';
import type { CustomerDoc } from '../customers/types.js';
import { nextBookingReference, trackingIdFor } from '../shipments/sequences.js';
import type { BookingDoc, Measurement, PieceDoc, PieceEventDoc, Party } from '../shipments/types.js';

/**
 * Requirement 1.2. Both parties, in full.
 *
 * The receiver's mobile is required and the sender's is not optional either:
 * this is the only lane by which a customs query or a failed delivery reaches
 * a human, and a shipment nobody can be contacted about becomes a shipment
 * sitting in a bonded warehouse accruing storage.
 */
export const PartyInput = z.object({
  name: z.string().trim().min(2).max(120),
  mobile: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 ()-]{6,19}$/, 'Enter a mobile number we can reach, with country code'),
  email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  line1: z.string().trim().min(3).max(160),
  line2: z.string().trim().max(160).optional().or(z.literal('').transform(() => undefined)),
  city: z.string().trim().min(2).max(80),
  region: z.string().trim().max(80).optional().or(z.literal('').transform(() => undefined)),
  postcode: z.string().trim().min(3).max(12),
  country: z.string().trim().length(2).toUpperCase(),
  idNumber: z.string().trim().max(40).optional().or(z.literal('').transform(() => undefined)),
});

export const CreateBooking = z.object({
  lane: z.string().min(3),
  service: ServiceMode,
  pieces: z.array(PieceInput).min(1).max(60),
  sender: PartyInput,
  receiver: PartyInput,
});
export type CreateBooking = z.infer<typeof CreateBooking>;

const measurementOf = (piece: PieceInput): Measurement => ({
  lengthMm: piece.lengthMm,
  widthMm: piece.widthMm,
  heightMm: piece.heightMm,
  weightGrams: piece.weightGrams,
  volume: volumeOf(piece.lengthMm, piece.widthMm, piece.heightMm),
});

const toParty = (input: z.infer<typeof PartyInput>): Party => ({
  name: input.name,
  mobile: input.mobile.replace(/[ ()-]/g, ''),
  ...(input.email ? { email: input.email } : {}),
  line1: input.line1,
  ...(input.line2 ? { line2: input.line2 } : {}),
  city: input.city,
  ...(input.region ? { region: input.region } : {}),
  postcode: input.postcode,
  country: input.country,
  ...(input.idNumber ? { idNumber: input.idNumber } : {}),
});

export interface CreatedBooking {
  reference: string;
  status: string;
  total: string;
  totalMinor: number;
  pieceCount: number;
  transit: { min: number; max: number };
  dropOff: { depot: string; address: string; cutOff: string };
}

/**
 * Requirement 1.3, the write half.
 *
 * The price is recomputed here from the pieces, never taken from the request.
 * The browser is not a source of truth about money — a quote posted back from
 * a tampered client, or simply a stale one from a rate card published while
 * the customer was filling in addresses, must not become what they owe.
 *
 * Tracking IDs are deliberately NOT issued. A piece gets one when it is
 * physically in our hands (requirement 2.1); until then the boxes exist only
 * as a promise, and a label printed for a box that never arrives is a box the
 * system believes it has.
 */
export const createBooking = async (
  input: CreateBooking,
  account: CustomerDoc,
): Promise<CreatedBooking> => {
  const lane = LANES.find((l) => l.code === input.lane);
  if (!lane) throw badRequest(`We do not ship ${input.lane}`, 'unknown_lane');

  const card = await getActiveRateCard();
  const now = new Date();

  // A named box is priced as that box, whatever dimensions arrived.
  const pieces = normaliseDeclared(input.pieces);

  const quoteRequest: QuoteRequest = {
    lane: input.lane,
    service: input.service,
    pieces,
  };

  let bookedQuote;
  try {
    bookedQuote = priceShipment(quoteRequest, card, now);
  } catch (error) {
    if (error instanceof PricingError) throw badRequest(error.message, error.code);
    throw error;
  }

  const sender = toParty(input.sender);
  const receiver = toParty(input.receiver);
  const reference = await nextBookingReference(now);

  await withTransaction(async (session) => {
      const bookingId = new ObjectId();

      const booking: BookingDoc = {
        _id: bookingId,
        reference,
        customerId: account._id!,
        customerRef: account.reference,
        customerName: account.name,
        lane: input.lane,
        service: input.service,
        sender,
        receiver,
        status: 'booked',
        bookedQuote,
        verifiedQuote: null,
        createdAt: now,
        updatedAt: now,
      };

      const pieceDocs: PieceDoc[] = pieces.map((piece, index) => ({
        bookingId,
        bookingRef: reference,
        consigneeName: receiver.name,
        destination: `${receiver.city}, ${receiver.country}`,
        trackingId: null,
        sequence: index + 1,
        packaging: piece.packaging,
        declared: measurementOf(piece),
        verified: null,
        status: 'booked',
        depotId: null,
        containerId: null,
        receivedAt: null,
        verifiedAt: null,
        createdAt: now,
      }));

      const events: PieceEventDoc[] = pieceDocs.map((piece) => ({
        at: now,
        // No tracking ID yet, so the audit trail keys on the booking and the
        // piece's position within it.
        pieceId: `${reference}#${piece.sequence}`,
        bookingRef: reference,
        code: 'booked',
        actor: account.reference,
        detail: `${piece.packaging.replace(/_/g, ' ')} declared ${piece.declared.lengthMm / 10}×${
          piece.declared.widthMm / 10
        }×${piece.declared.heightMm / 10} cm, ${(piece.declared.weightGrams / 1000).toFixed(1)} kg`,
      }));

      await collection<BookingDoc>(COLLECTIONS.bookings).insertOne(booking, { session });
      await collection<PieceDoc>(COLLECTIONS.pieces).insertMany(pieceDocs, { session });
      await collection<PieceEventDoc>(COLLECTIONS.pieceEvents).insertMany(events, { session });
    });

  // Next time they book, the sender block fills itself in.
  await rememberSender(account._id!, sender);

  const total = formatMoney(bookedQuote.total);

  // Outside the transaction on purpose: a failed notification must not roll
  // back a booking the customer has already been shown.
  await notifications.send({
    entityId: reference,
    event: 'booking_confirmed',
    bookingRef: reference,
    to: { email: account.email, mobile: account.mobile },
    data: {
      customerName: account.name,
      bookingRef: reference,
      total,
      pieceCount: input.pieces.length,
      route: `${lane.from} → ${lane.to}`,
      depot: 'our Peliyagoda depot',
      depotAddress: '118 Negombo Road, Peliyagoda 11600',
    },
  });

  return {
    reference,
    status: 'booked',
    total,
    totalMinor: bookedQuote.total.amount,
    pieceCount: input.pieces.length,
    transit: { min: bookedQuote.transitDaysMin, max: bookedQuote.transitDaysMax },
    dropOff: {
      depot: 'CargoFlow Peliyagoda',
      address: '118 Negombo Road, Peliyagoda 11600, Sri Lanka',
      cutOff: 'Monday to Saturday, 08:00–18:00',
    },
  };
};

/** What the label on each box will say once the depot receives it. */
export const previewTrackingIds = (reference: string, pieceCount: number): string[] =>
  Array.from({ length: pieceCount }, (_, i) => trackingIdFor(reference, i + 1));
