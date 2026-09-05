import type { ObjectId } from 'mongodb';
import { COLLECTIONS, collection } from '../../db/mongo.js';
import type { AdjustmentDoc, BookingDoc, ContainerDoc, PieceDoc, PieceEventDoc } from './types.js';

const bookings = () => collection<BookingDoc>(COLLECTIONS.bookings);
const pieces = () => collection<PieceDoc>(COLLECTIONS.pieces);
const adjustments = () => collection<AdjustmentDoc>(COLLECTIONS.adjustments);
const containers = () => collection<ContainerDoc>(COLLECTIONS.containers);
const events = () => collection<PieceEventDoc>(COLLECTIONS.pieceEvents);

export const findBookingByReference = async (reference: string): Promise<BookingDoc | null> =>
  bookings().findOne({ reference });

export const findPieceByTrackingId = async (trackingId: string): Promise<PieceDoc | null> =>
  pieces().findOne({ trackingId });

export const findPiecesForBooking = async (bookingId: ObjectId): Promise<PieceDoc[]> =>
  pieces().find({ bookingId }).sort({ sequence: 1 }).toArray();

export const findOpenAdjustment = async (bookingId: ObjectId): Promise<AdjustmentDoc | null> =>
  adjustments().findOne(
    { bookingId, state: { $in: ['awaiting_approval', 'declined'] } },
    { sort: { raisedAt: -1 } },
  );

export const findContainer = async (id: ObjectId | null): Promise<ContainerDoc | null> =>
  id ? containers().findOne({ _id: id }) : null;

export const findEventsForBooking = async (bookingRef: string): Promise<PieceEventDoc[]> =>
  events().find({ bookingRef }).sort({ at: 1 }).toArray();

/**
 * Resolve whatever the customer typed into the box.
 *
 * They have two numbers on two different pieces of paper — the booking
 * reference from the confirmation email and the tracking ID from the label on
 * the box — and no reason to know which one we want. Accept either, and be
 * forgiving about spaces and case while we are at it.
 */
export const resolveReference = async (
  input: string,
): Promise<{ booking: BookingDoc; matchedPiece: PieceDoc | null } | null> => {
  const cleaned = input.trim().toUpperCase().replace(/\s+/g, '');
  if (cleaned.length < 4) return null;

  const piece = await findPieceByTrackingId(cleaned);
  if (piece) {
    const booking = await bookings().findOne({ _id: piece.bookingId });
    return booking ? { booking, matchedPiece: piece } : null;
  }

  const booking = await findBookingByReference(cleaned);
  return booking ? { booking, matchedPiece: null } : null;
};

export const insertBooking = async (doc: BookingDoc): Promise<ObjectId> => {
  const result = await bookings().insertOne(doc);
  return result.insertedId;
};

export const insertPieces = async (docs: PieceDoc[]): Promise<void> => {
  if (docs.length > 0) await pieces().insertMany(docs);
};

export const insertAdjustment = async (doc: AdjustmentDoc): Promise<void> => {
  await adjustments().insertOne(doc);
};

export const insertContainer = async (doc: ContainerDoc): Promise<ObjectId> => {
  const result = await containers().insertOne(doc);
  return result.insertedId;
};

/** Append-only: events are inserted and never touched again. */
export const recordEvents = async (docs: PieceEventDoc[]): Promise<void> => {
  if (docs.length > 0) await events().insertMany(docs);
};

export const countBookings = async (): Promise<number> => bookings().countDocuments();
