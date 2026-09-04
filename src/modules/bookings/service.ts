import { ObjectId, type ClientSession } from 'mongodb';
import { z } from 'zod';
import { COLLECTIONS, collection, withTransaction } from '../../db/mongo.js';
import { badRequest } from '../../shared/errors.js';
import { formatMoney, volumeOf } from '../../shared/units.js';
import { priceShipment, PricingError } from '../pricing/engine.js';
import { getActiveRateCard } from '../pricing/repository.js';
import { LANES } from '../pricing/rate-cards.js';
import { PieceInput, ServiceMode, type QuoteRequest } from '../pricing/types.js';
import * as notifications from '../notifications/service.js';
import {
  nextBookingReference,
  nextCustomerReference,
  trackingIdFor,
} from '../shipments/sequences.js';
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
  declaredValue: z.number().int().min(0).max(100_000_00).default(0),
  coverRequested: z.boolean().default(false),
  pickupRequested: z.boolean().default(false),
  remoteDelivery: z.boolean().default(false),
  sender: PartyInput,
  receiver: PartyInput,
});
export type CreateBooking = z.infer<typeof CreateBooking>;

interface CustomerDoc {
  _id?: ObjectId;
  reference: string;
  name: string;
  mobile: string;
  email?: string;
  createdAt: Date;
}

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

/**
 * A returning customer is matched on mobile number, not email.
 *
 * Households share an email address far more often than they share a phone,
 * and the mobile is what the SMS goes to.
 */
const findOrCreateCustomer = async (
  sender: Party,
  session: ClientSession | undefined,
): Promise<CustomerDoc> => {
  const customers = collection<CustomerDoc>(COLLECTIONS.customers);
  const existing = await customers.findOne({ mobile: sender.mobile }, { session });
  if (existing) return existing;

  const doc: CustomerDoc = {
    reference: await nextCustomerReference(),
    name: sender.name,
    mobile: sender.mobile,
    ...(sender.email ? { email: sender.email } : {}),
    createdAt: new Date(),
  };
  await customers.insertOne(doc, { session });
  return doc;
};

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
export const createBooking = async (input: CreateBooking): Promise<CreatedBooking> => {
  const lane = LANES.find((l) => l.code === input.lane);
  if (!lane) throw badRequest(`We do not ship ${input.lane}`, 'unknown_lane');

  const card = await getActiveRateCard();
  const now = new Date();

  const quoteRequest: QuoteRequest = {
    lane: input.lane,
    service: input.service,
    pieces: input.pieces,
    declaredValue: input.declaredValue,
    coverRequested: input.coverRequested,
    pickupRequested: input.pickupRequested,
    remoteDelivery: input.remoteDelivery,
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
      const customer = await findOrCreateCustomer(sender, session);
      const bookingId = new ObjectId();

      const booking: BookingDoc = {
        _id: bookingId,
        reference,
        customerRef: customer.reference,
        customerName: sender.name,
        lane: input.lane,
        service: input.service,
        sender,
        receiver,
        declaredValue: input.declaredValue,
        coverRequested: input.coverRequested,
        pickupRequested: input.pickupRequested,
        status: 'booked',
        bookedQuote,
        verifiedQuote: null,
        createdAt: now,
        updatedAt: now,
      };

      const pieces: PieceDoc[] = input.pieces.map((piece, index) => ({
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

      const events: PieceEventDoc[] = pieces.map((piece) => ({
        at: now,
        // No tracking ID yet, so the audit trail keys on the booking and the
        // piece's position within it.
        pieceId: `${reference}#${piece.sequence}`,
        bookingRef: reference,
        code: 'booked',
        actor: customer.reference,
        detail: `${piece.packaging.replace(/_/g, ' ')} declared ${piece.declared.lengthMm / 10}×${
          piece.declared.widthMm / 10
        }×${piece.declared.heightMm / 10} cm, ${(piece.declared.weightGrams / 1000).toFixed(1)} kg`,
      }));

      await collection<BookingDoc>(COLLECTIONS.bookings).insertOne(booking, { session });
      await collection<PieceDoc>(COLLECTIONS.pieces).insertMany(pieces, { session });
      await collection<PieceEventDoc>(COLLECTIONS.pieceEvents).insertMany(events, { session });
    });

  const total = formatMoney(bookedQuote.total);

  // Outside the transaction on purpose: a failed notification must not roll
  // back a booking the customer has already been shown.
  await notifications.send({
    entityId: reference,
    event: 'booking_confirmed',
    bookingRef: reference,
    to: { email: sender.email, mobile: sender.mobile },
    subject: `Booking ${reference} confirmed — ${total}`,
    body: [
      `Thanks ${sender.name.split(' ')[0]}, your booking is in.`,
      '',
      `Reference: ${reference}`,
      `${input.pieces.length} ${input.pieces.length === 1 ? 'box' : 'boxes'} · ${lane.from} → ${lane.to}`,
      `Estimated price: ${total} including GST`,
      '',
      'Drop your boxes at our Peliyagoda depot. We weigh and measure every one,',
      'and if anything differs from what you told us we will send you the new',
      'price and wait for your yes before charging it.',
    ].join('\n'),
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
