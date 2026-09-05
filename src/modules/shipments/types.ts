import type { ObjectId } from 'mongodb';
import type { Minor } from '../../shared/units.js';
import type { PackagingKind, Quote, ServiceMode } from '../pricing/types.js';

/**
 * Status lives on the piece, not the booking.
 *
 * A customer books four boxes; three arrive Monday, one Thursday, two verify
 * clean, one is re-rated and one is damaged. If status were a column on the
 * booking that reality could not be represented, and staff would resort to
 * notes fields and phone calls. A booking's status is derived — it reports the
 * least-advanced piece it contains.
 */
export const PIECE_STATUS_ORDER = [
  'booked',
  'received',
  'verified',
  'rerate_held',
  'labelled',
  'loaded',
  'in_transit',
  'cleared',
  'delivered',
] as const;

export type PieceStatus = (typeof PIECE_STATUS_ORDER)[number] | 'held';

export interface Measurement {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  weightGrams: number;
  /** Ten-thousandths of m³, rounded per piece. */
  volume: number;
}

export interface Party {
  name: string;
  mobile: string;
  email?: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postcode: string;
  country: string;
  /** NIC or passport — needed for customs, encrypted at rest in production. */
  idNumber?: string;
}

export interface BookingDoc {
  _id?: ObjectId;
  reference: string;
  /** The account that made it. Absent on walk-ins taken at the counter. */
  customerId?: ObjectId;
  customerRef: string;
  customerName: string;
  lane: string;
  service: ServiceMode;
  sender: Party;
  receiver: Party;
  /** Derived from its pieces, maintained in the same transaction. */
  status: PieceStatus;
  bookedQuote: Quote;
  verifiedQuote: Quote | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PieceDoc {
  _id?: ObjectId;
  bookingId: ObjectId;
  /** Denormalised so the loading board renders from one query, no lookup. */
  bookingRef: string;
  consigneeName: string;
  destination: string;
  /** Issued on physical receipt, never at booking. */
  trackingId: string | null;
  sequence: number;
  packaging: PackagingKind;
  declared: Measurement;
  verified: Measurement | null;
  status: PieceStatus;
  depotId: string | null;
  containerId: ObjectId | null;
  receivedAt: Date | null;
  verifiedAt: Date | null;
  createdAt: Date;
}

export type AdjustmentState =
  | 'awaiting_approval'
  | 'approved'
  | 'declined'
  | 'auto_approved'
  | 'waived'
  | 'settled';

export interface AdjustmentDoc {
  _id?: ObjectId;
  reference: string;
  bookingId: ObjectId;
  bookingRef: string;
  state: AdjustmentState;
  bookedTotal: Minor;
  verifiedTotal: Minor;
  difference: Minor;
  differenceBasisPoints: number;
  toleranceApplied: Minor;
  changedPieceIndexes: number[];
  raisedAt: Date;
  raisedBy: string;
  autoApproveAt: Date | null;
  settledAt: Date | null;
}

/** Append-only. Never updated, never deleted. */
export interface PieceEventDoc {
  at: Date;
  pieceId: string;
  bookingRef: string;
  code:
    | 'booked'
    | 'received'
    | 'measured'
    | 'rerated'
    | 'approved'
    | 'labelled'
    | 'loaded'
    | 'sealed'
    | 'delivered'
    | 'held';
  actor: string;
  workstation?: string;
  detail: string;
}

export interface ContainerDoc {
  _id?: ObjectId;
  containerNumber: string;
  type: string;
  vessel: string;
  voyage: string;
  lane: string;
  destinationLabel: string;
  status: 'open' | 'sealed' | 'in_transit' | 'arrived' | 'devanned';
  capacityVolume: number;
  cutOffAt: Date;
  sailsAt: Date;
  etaAt: Date;
  sealNumber: string | null;
}

/** The least-advanced piece decides what the booking is doing. */
export const deriveBookingStatus = (pieces: Pick<PieceDoc, 'status'>[]): PieceStatus => {
  if (pieces.length === 0) return 'booked';
  if (pieces.some((p) => p.status === 'held')) return 'held';
  if (pieces.some((p) => p.status === 'rerate_held')) return 'rerate_held';

  let lowest = PIECE_STATUS_ORDER.length - 1;
  for (const piece of pieces) {
    const index = PIECE_STATUS_ORDER.indexOf(piece.status as (typeof PIECE_STATUS_ORDER)[number]);
    if (index >= 0 && index < lowest) lowest = index;
  }
  return PIECE_STATUS_ORDER[lowest] ?? 'booked';
};

/** What a customer should be told a status means. Never the internal word. */
export const PIECE_STATUS_LABELS: Record<PieceStatus, string> = {
  booked: 'Booked',
  received: 'At the depot',
  verified: 'Checked — spot on',
  rerate_held: 'Measured bigger',
  labelled: 'Labelled and ready',
  loaded: 'In the container',
  in_transit: 'On the water',
  cleared: 'Through customs',
  delivered: 'Delivered',
  held: 'On hold',
};
