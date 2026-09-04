import { ObjectId } from 'mongodb';
import { volumeOf } from '../../shared/units.js';
import { assessRerate, priceShipment } from '../pricing/engine.js';
import { getActiveRateCard } from '../pricing/repository.js';
import type { PieceInput, QuoteRequest } from '../pricing/types.js';
import {
  countBookings,
  insertAdjustment,
  insertBooking,
  insertContainer,
  insertPieces,
  recordEvents,
} from './repository.js';
import type { Measurement, PieceDoc, PieceEventDoc, PieceStatus } from './types.js';

/**
 * Booking BK-26-8817 — the worked example the UI deck, the architecture
 * document and the pricing tests all quote.
 *
 * Seeding it means /track returns something real from the first minute, and
 * the re-rate approval flow can be walked end to end before the booking wizard
 * exists. Development data only; it never runs against a seeded database.
 */

const measurement = (lengthMm: number, widthMm: number, heightMm: number, weightGrams: number): Measurement => ({
  lengthMm,
  widthMm,
  heightMm,
  weightGrams,
  volume: volumeOf(lengthMm, widthMm, heightMm),
});

const DECLARED: PieceInput[] = [
  { packaging: 'large_box', lengthMm: 600, widthMm: 450, heightMm: 450, weightGrams: 24_000 },
  { packaging: 'large_box', lengthMm: 600, widthMm: 450, heightMm: 450, weightGrams: 22_500 },
  { packaging: 'custom_carton', lengthMm: 700, widthMm: 500, heightMm: 450, weightGrams: 31_000 },
  { packaging: 'barrel', lengthMm: 450, widthMm: 450, heightMm: 900, weightGrams: 28_000 },
];

/** What the depot actually measured: pieces 3 and 4 came in bigger. */
const VERIFIED: PieceInput[] = [
  DECLARED[0]!,
  DECLARED[1]!,
  { packaging: 'custom_carton', lengthMm: 780, widthMm: 580, heightMm: 520, weightGrams: 34_600 },
  { packaging: 'barrel', lengthMm: 470, widthMm: 470, heightMm: 920, weightGrams: 29_800 },
];

const BOOKED_AT = new Date('2026-08-28T09:07:00Z'); // 14:37 Colombo
const RECEIVED_AT = new Date('2026-09-01T03:22:00Z'); // 08:52 Colombo
const MEASURED_AT = new Date('2026-09-01T03:42:00Z'); // 09:12 Colombo
const RERATED_AT = new Date('2026-09-01T04:11:00Z'); // 09:41 Colombo

export const seedDemoShipment = async (): Promise<void> => {
  if ((await countBookings()) > 0) return;

  const card = await getActiveRateCard();

  const base = {
    lane: 'LKCMB-AUMEL',
    service: 'sea_lcl' as const,
    declaredValue: 1_800_00,
    coverRequested: true,
    pickupRequested: false,
    remoteDelivery: false,
  };

  const bookedRequest: QuoteRequest = { ...base, pieces: DECLARED };
  const verifiedRequest: QuoteRequest = { ...base, pieces: VERIFIED };

  const bookedQuote = priceShipment(bookedRequest, card, BOOKED_AT);
  const verifiedQuote = priceShipment(verifiedRequest, card, RERATED_AT);
  const assessment = assessRerate(bookedQuote, verifiedQuote, card, RERATED_AT);

  const containerId = await insertContainer({
    containerNumber: 'CFLU 482 9317',
    type: '40ft high cube',
    vessel: 'MV Serendib Star',
    voyage: 'V.0247E',
    lane: 'LKCMB-AUMEL',
    destinationLabel: 'Melbourne',
    status: 'open',
    capacityVolume: 677_000,
    cutOffAt: new Date('2026-09-10T11:30:00Z'),
    sailsAt: new Date('2026-09-12T00:00:00Z'),
    etaAt: new Date('2026-10-03T00:00:00Z'),
    sealNumber: null,
  });

  const bookingId = new ObjectId();

  await insertBooking({
    _id: bookingId,
    reference: 'BK-26-8817',
    customerRef: 'CF-04412',
    customerName: 'Nadeesha Perera',
    lane: base.lane,
    service: base.service,
    declaredValue: base.declaredValue,
    coverRequested: base.coverRequested,
    pickupRequested: base.pickupRequested,
    // Two pieces are held on an unapproved re-rate, so the booking is too.
    status: 'rerate_held',
    bookedQuote,
    verifiedQuote,
    createdAt: BOOKED_AT,
    updatedAt: RERATED_AT,
    sender: {
      name: 'Nadeesha Perera',
      mobile: '+94774128890',
      email: 'nadeesha.perera@example.lk',
      line1: '42 Galle Road',
      city: 'Wellawatte',
      postcode: '00600',
      country: 'LK',
      idNumber: '199384501V',
    },
    receiver: {
      name: 'Dilan Perera',
      mobile: '+61412887004',
      email: 'dilan.perera@example.com.au',
      line1: '18 Whitehorse Road',
      city: 'Box Hill',
      region: 'VIC',
      postcode: '3128',
      country: 'AU',
    },
  });

  const changed = new Set(assessment.changedPieceIndexes);

  const pieceDocs: PieceDoc[] = DECLARED.map((declared, index) => {
    const verified = VERIFIED[index]!;
    const wasRerated = changed.has(index);
    const status: PieceStatus = wasRerated ? 'rerate_held' : 'verified';

    return {
      bookingId,
      bookingRef: 'BK-26-8817',
      consigneeName: 'Dilan Perera',
      destination: 'Box Hill VIC 3128',
      // Tracking IDs are issued on physical receipt, never at booking.
      trackingId: `CF-8817-${String(index + 1).padStart(3, '0')}`,
      sequence: index + 1,
      packaging: declared.packaging,
      declared: measurement(declared.lengthMm, declared.widthMm, declared.heightMm, declared.weightGrams),
      verified: measurement(verified.lengthMm, verified.widthMm, verified.heightMm, verified.weightGrams),
      status,
      depotId: 'PELIYAGODA',
      containerId: null,
      receivedAt: RECEIVED_AT,
      verifiedAt: MEASURED_AT,
      createdAt: BOOKED_AT,
    };
  });

  await insertPieces(pieceDocs);

  await insertAdjustment({
    reference: 'ADJ-2026-00318',
    bookingId,
    bookingRef: 'BK-26-8817',
    state: 'awaiting_approval',
    bookedTotal: bookedQuote.total.amount,
    verifiedTotal: verifiedQuote.total.amount,
    difference: assessment.difference.amount,
    differenceBasisPoints: assessment.differenceBasisPoints,
    toleranceApplied: assessment.toleranceApplied.amount,
    changedPieceIndexes: assessment.changedPieceIndexes,
    raisedAt: RERATED_AT,
    raisedBy: 'R. Fernando · WS-03',
    autoApproveAt: assessment.autoApproveAt,
    settledAt: null,
  });

  const events: PieceEventDoc[] = [];
  for (const piece of pieceDocs) {
    const id = piece.trackingId!;
    events.push({
      at: BOOKED_AT,
      pieceId: id,
      bookingRef: 'BK-26-8817',
      code: 'booked',
      actor: 'Nadeesha Perera',
      detail: `Booked as ${piece.declared.lengthMm / 10}×${piece.declared.widthMm / 10}×${
        piece.declared.heightMm / 10
      } cm, ${(piece.declared.weightGrams / 1000).toFixed(1)} kg`,
    });
    events.push({
      at: RECEIVED_AT,
      pieceId: id,
      bookingRef: 'BK-26-8817',
      code: 'received',
      actor: 'R. Fernando',
      workstation: 'WS-03',
      detail: `Tracking ID ${id} issued on receipt`,
    });
    events.push({
      at: MEASURED_AT,
      pieceId: id,
      bookingRef: 'BK-26-8817',
      code: 'measured',
      actor: 'R. Fernando',
      workstation: 'WS-03',
      detail: `Measured ${piece.verified!.lengthMm / 10}×${piece.verified!.widthMm / 10}×${
        piece.verified!.heightMm / 10
      } cm, ${(piece.verified!.weightGrams / 1000).toFixed(1)} kg`,
    });
    if (piece.status === 'rerate_held') {
      events.push({
        at: RERATED_AT,
        pieceId: id,
        bookingRef: 'BK-26-8817',
        code: 'rerated',
        actor: 'R. Fernando',
        workstation: 'WS-03',
        detail: 'Measured larger than declared — shipment re-rated, customer notified',
      });
    }
  }

  await recordEvents(events);

  // Container exists but nothing is loaded into it: a piece cannot enter a
  // container while the money is in dispute.
  void containerId;
};
