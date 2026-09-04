import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, notFound } from '../../shared/errors.js';
import { formatMinor, formatMoney, formatVolume, money } from '../../shared/units.js';
import { LANES } from '../pricing/rate-cards.js';
import {
  findContainer,
  findOpenAdjustment,
  findPiecesForBooking,
  resolveReference,
} from './repository.js';
import { PIECE_STATUS_LABELS, type AdjustmentDoc, type BookingDoc, type PieceDoc } from './types.js';

/** The lane knows the port pair; the receiver's suburb is not the destination. */
const routeFor = (lane: string, fallbackTo: string) => {
  const known = LANES.find((l) => l.code === lane);
  return { from: known?.from ?? 'Colombo', to: known?.to ?? fallbackTo };
};

type Stage = { code: string; title: string; detail: string; at: string | null; state: 'done' | 'current' | 'pending' };

/**
 * The customer-facing journey.
 *
 * Deliberately not a dump of the event log — a person tracking a box wants six
 * plain stages, not forty rows of `measured`. The event log is what an audit
 * reads; this is what a worried customer reads.
 */
const buildTimeline = (
  booking: BookingDoc,
  pieces: PieceDoc[],
  adjustment: AdjustmentDoc | null,
  container: Awaited<ReturnType<typeof findContainer>>,
): Stage[] => {
  const receivedCount = pieces.filter((p) => p.receivedAt).length;
  const receivedAt = pieces.map((p) => p.receivedAt).filter(Boolean).sort()[0] ?? null;
  const verifiedAt = pieces.map((p) => p.verifiedAt).filter(Boolean).sort().at(-1) ?? null;
  const awaitingCustomer = adjustment?.state === 'awaiting_approval';
  const loaded = pieces.some((p) => p.containerId);

  return [
    {
      code: 'booked',
      title: 'You booked and paid',
      detail: `${formatMoney(money(booking.bookedQuote.total.amount))} on your card · drop-off slip emailed`,
      at: booking.createdAt.toISOString(),
      state: 'done',
    },
    {
      code: 'received',
      title:
        receivedCount === pieces.length
          ? `All ${pieces.length} boxes arrived at the depot`
          : `${receivedCount} of ${pieces.length} boxes arrived`,
      detail: 'Each one got its own number and barcode label',
      at: receivedAt ? new Date(receivedAt).toISOString() : null,
      state: receivedCount > 0 ? 'done' : 'pending',
    },
    {
      code: 'verified',
      title: awaitingCustomer ? 'Weighed and re-priced' : 'Weighed and checked',
      detail: awaitingCustomer
        ? 'New price sent by text and email — waiting for your yes'
        : 'Everything matched what you told us',
      at: verifiedAt ? new Date(verifiedAt).toISOString() : null,
      state: awaitingCustomer ? 'current' : verifiedAt ? 'done' : 'pending',
    },
    {
      code: 'loaded',
      title: 'Loaded into the container',
      detail: container
        ? `Next one out closes on ${container.cutOffAt.toLocaleDateString('en-AU', { day: 'numeric', month: 'long' })}`
        : 'Waiting for the next container',
      at: null,
      state: loaded ? 'done' : 'pending',
    },
    {
      code: 'in_transit',
      title: 'On the water',
      detail: container ? `${container.vessel}, Colombo to ${container.destinationLabel}` : 'Not yet sailed',
      at: null,
      state: 'pending',
    },
    {
      code: 'delivered',
      title: `Delivered to ${booking.receiver.name.split(' ')[0]}'s door`,
      detail: `${booking.receiver.city} ${booking.receiver.region ?? ''} ${booking.receiver.postcode} · photo ID needed on the day`.trim(),
      at: null,
      state: 'pending',
    },
  ];
};

const presentMeasurement = (m: PieceDoc['declared']) => ({
  dimensionsCm: `${m.lengthMm / 10} × ${m.widthMm / 10} × ${m.heightMm / 10}`,
  weightKg: (m.weightGrams / 1000).toFixed(1),
  volume: formatVolume(m.volume),
});

export const shipmentRoutes = async (app: FastifyInstance): Promise<void> => {
  /**
   * Public tracking. No account, no password — just the number on the label,
   * which is the only thing a receiver in Melbourne is likely to have.
   *
   * Returns nothing that would embarrass us if the wrong person typed a
   * neighbour's tracking ID: no addresses, no phone numbers, no line-item
   * pricing. Just where the boxes are.
   */
  app.get('/v1/track/:reference', async (request) => {
    const params = z.object({ reference: z.string().min(3).max(40) }).safeParse(request.params);
    if (!params.success) throw notFound('That reference');

    const resolved = await resolveReference(params.data.reference);
    if (!resolved) {
      throw new AppError(
        `We cannot find anything matching ${params.data.reference}. Check the number on your label or your confirmation email.`,
        'shipment_not_found',
        404,
      );
    }

    const { booking, matchedPiece } = resolved;
    const pieces = await findPiecesForBooking(booking._id!);
    const adjustment = await findOpenAdjustment(booking._id!);
    const container = await findContainer(pieces.find((p) => p.containerId)?.containerId ?? null);

    const payable = booking.verifiedQuote && adjustment?.state !== 'awaiting_approval'
      ? booking.verifiedQuote.total.amount
      : booking.bookedQuote.total.amount;

    return {
      booking: {
        reference: booking.reference,
        customerName: booking.customerName,
        route: routeFor(booking.lane, booking.receiver.city),
        service: booking.service,
        status: booking.status,
        statusLabel: PIECE_STATUS_LABELS[booking.status],
        bookedAt: booking.createdAt.toISOString(),
        pieceCount: pieces.length,
      },
      matchedTrackingId: matchedPiece?.trackingId ?? null,
      pieces: pieces.map((piece) => ({
        trackingId: piece.trackingId,
        sequence: piece.sequence,
        packaging: piece.packaging,
        status: piece.status,
        statusLabel: PIECE_STATUS_LABELS[piece.status],
        declared: presentMeasurement(piece.declared),
        verified: piece.verified ? presentMeasurement(piece.verified) : null,
        changed: piece.status === 'rerate_held',
      })),
      timeline: buildTimeline(booking, pieces, adjustment, container),
      adjustment: adjustment
        ? {
            reference: adjustment.reference,
            state: adjustment.state,
            bookedTotal: formatMinor(adjustment.bookedTotal),
            verifiedTotal: formatMinor(adjustment.verifiedTotal),
            difference: formatMinor(adjustment.difference),
            differenceDisplay: formatMoney(money(adjustment.difference)),
            differencePercent: (adjustment.differenceBasisPoints / 100).toFixed(1),
            changedPieceIndexes: adjustment.changedPieceIndexes,
            raisedAt: adjustment.raisedAt.toISOString(),
            autoApproveAt: adjustment.autoApproveAt?.toISOString() ?? null,
          }
        : null,
      container: container
        ? {
            number: container.containerNumber,
            vessel: container.vessel,
            voyage: container.voyage,
            cutOffAt: container.cutOffAt.toISOString(),
            etaAt: container.etaAt.toISOString(),
          }
        : null,
      totals: {
        declaredVolume: formatVolume(booking.bookedQuote.volume),
        verifiedVolume: booking.verifiedQuote ? formatVolume(booking.verifiedQuote.volume) : null,
        weightKg: (booking.bookedQuote.weightGrams / 1000).toFixed(1),
        payable: formatMinor(payable),
        payableDisplay: formatMoney(money(payable)),
      },
    };
  });
};
