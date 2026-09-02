import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../../shared/errors.js';
import { formatMoney, formatVolume, formatMinor } from '../../shared/units.js';
import { priceShipment, PricingError } from './engine.js';
import { getActiveRateCard } from './repository.js';
import { LANES, PACKAGING_PRESETS } from './rate-cards.js';
import { QuoteRequest, type Quote } from './types.js';

/** Shape the engine's internals into something a browser wants to render. */
const presentQuote = (quote: Quote) => ({
  rateCardVersion: quote.rateCardVersion,
  currency: quote.currency,
  lane: quote.lane,
  service: quote.service,
  pieceCount: quote.pieceCount,
  volume: {
    raw: quote.volume,
    display: formatVolume(quote.volume),
    unit: 'm³',
  },
  chargeable: {
    raw: quote.chargeableQuantity,
    display:
      quote.chargeableUnit === 'm3'
        ? formatVolume(quote.chargeableQuantity)
        : (quote.chargeableQuantity / 1000).toFixed(1),
    unit: quote.chargeableUnit === 'm3' ? 'm³' : 'kg',
    minimumApplied: quote.chargeableQuantity > (quote.chargeableUnit === 'm3' ? quote.volume : 0),
  },
  weightKg: (quote.weightGrams / 1000).toFixed(1),
  pieces: quote.pieces.map((p, index) => ({
    index,
    packaging: p.packaging,
    dimensionsCm: `${p.lengthMm / 10} × ${p.widthMm / 10} × ${p.heightMm / 10}`,
    weightKg: (p.weightGrams / 1000).toFixed(1),
    volume: formatVolume(p.volume),
    oversize: p.oversize,
  })),
  lines: quote.lines.map((line) => ({
    code: line.code,
    label: line.label,
    basis: line.basis,
    amount: formatMinor(line.amount.amount),
    amountMinor: line.amount.amount,
  })),
  subtotal: formatMinor(quote.subtotal.amount),
  tax: formatMinor(quote.tax.amount),
  total: formatMinor(quote.total.amount),
  totalMinor: quote.total.amount,
  totalDisplay: formatMoney(quote.total),
  transit: { min: quote.transitDaysMin, max: quote.transitDaysMax },
});

export const pricingRoutes = async (app: FastifyInstance): Promise<void> => {
  /**
   * Everything the booking wizard needs to render itself: the lanes we serve
   * and the packaging presets, straight from the active rate card. The client
   * hardcodes none of it.
   */
  app.get('/v1/reference', async () => {
    const card = await getActiveRateCard();
    return {
      rateCardVersion: card.version,
      currency: card.currency,
      lanes: LANES.map((lane) => ({
        ...lane,
        services: card.lanes
          .filter((l) => l.lane === lane.code)
          .map((l) => ({
            service: l.service,
            ratePerUnit: formatMinor(l.rate),
            unit: l.service === 'sea_lcl' ? 'm³' : 'kg',
            minimum:
              l.service === 'sea_lcl'
                ? `${formatVolume(l.minimumQuantity)} m³`
                : `${l.minimumQuantity / 1000} kg`,
            transit: { min: l.transitDaysMin, max: l.transitDaysMax },
          })),
      })),
      packaging: PACKAGING_PRESETS,
      surcharges: {
        handlingPerPiece: formatMinor(card.surcharges.handlingPerPiece),
        customsClearance: formatMinor(card.surcharges.customsClearance),
        originPickup: formatMinor(card.surcharges.originPickup),
        remoteDelivery: formatMinor(card.surcharges.remoteDelivery),
        oversizePiece: formatMinor(card.surcharges.oversizePiece),
      },
      cover: {
        percent: (card.cover.basisPoints / 100).toFixed(1),
        minimum: formatMinor(card.cover.minimum),
      },
      taxPercent: (card.taxBasisPoints / 100).toFixed(0),
    };
  });

  /**
   * Price a shipment. Public and unauthenticated — this is the landing page
   * calculator as much as it is step one of the wizard. It writes nothing.
   */
  app.post('/v1/quotes/estimate', async (request) => {
    const parsed = QuoteRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('That shipment does not look right', 'invalid_quote_request', parsed.error.flatten());
    }

    const card = await getActiveRateCard();

    try {
      return { quote: presentQuote(priceShipment(parsed.data, card)) };
    } catch (error) {
      if (error instanceof PricingError) {
        throw badRequest(error.message, error.code);
      }
      throw error;
    }
  });

  /**
   * Price the same shipment twice — as booked and as measured — and report what
   * the business is allowed to do about the difference. The depot calls this
   * before it commits anything, so the operator sees the money consequence on
   * the same screen as the measurement.
   */
  app.post('/v1/quotes/compare', async (request) => {
    const Body = z.object({ booked: QuoteRequest, verified: QuoteRequest });
    const parsed = Body.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Expected a booked and a verified shipment', 'invalid_compare_request', parsed.error.flatten());
    }

    const card = await getActiveRateCard();
    const { assessRerate } = await import('./engine.js');
    const booked = priceShipment(parsed.data.booked, card);
    const verified = priceShipment(parsed.data.verified, card);
    const assessment = assessRerate(booked, verified, card);

    return {
      outcome: assessment.outcome,
      booked: presentQuote(booked),
      verified: presentQuote(verified),
      difference: formatMinor(assessment.difference.amount),
      differenceDisplay: formatMoney(assessment.difference),
      differencePercent: (assessment.differenceBasisPoints / 100).toFixed(1),
      tolerance: formatMinor(assessment.toleranceApplied.amount),
      changedPieceIndexes: assessment.changedPieceIndexes,
      autoApproveAt: assessment.autoApproveAt?.toISOString() ?? null,
    };
  });
};
