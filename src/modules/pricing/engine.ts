/**
 * The pricing engine.
 *
 * A pure function: measurements and a rate card in, a fully itemised quote
 * out. No database, no clock beyond a passed-in timestamp, no I/O. That purity
 * is the whole trick behind re-rating — verification runs this exact function
 * on the depot's measurements instead of the customer's, and the difference
 * between the two results is the adjustment.
 */
import {
  addMoney,
  applyBasisPoints,
  formatMinor,
  formatVolume,
  maxMoney,
  money,
  sumVolume,
  volumeOf,
  volumetricGrams,
  type Money,
} from '../../shared/units.js';
import type {
  LaneRate,
  PricedPiece,
  Quote,
  QuoteLine,
  QuoteRequest,
  RateCard,
  RerateAssessment,
  RerateOutcome,
} from './types.js';

export class PricingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

const findLane = (card: RateCard, lane: string, service: QuoteRequest['service']): LaneRate => {
  const found = card.lanes.find((l) => l.lane === lane && l.service === service);
  if (!found) {
    throw new PricingError(`No rate for ${lane} by ${service} on card v${card.version}`, 'lane_not_found');
  }
  return found;
};

const priceOnePiece = (piece: QuoteRequest['pieces'][number], card: RateCard, lane: LaneRate): PricedPiece => {
  const volume = volumeOf(piece.lengthMm, piece.widthMm, piece.heightMm);
  const longestSide = Math.max(piece.lengthMm, piece.widthMm, piece.heightMm);
  const chargeableGrams =
    lane.volumetricDivisor === undefined
      ? piece.weightGrams
      : Math.max(
          piece.weightGrams,
          volumetricGrams(piece.lengthMm, piece.widthMm, piece.heightMm, lane.volumetricDivisor),
        );

  return {
    packaging: piece.packaging,
    lengthMm: piece.lengthMm,
    widthMm: piece.widthMm,
    heightMm: piece.heightMm,
    weightGrams: piece.weightGrams,
    volume,
    chargeableGrams,
    oversize:
      longestSide > card.surcharges.oversizeLongestSideMm ||
      piece.weightGrams > card.surcharges.oversizeWeightGrams,
  };
};

/**
 * Price a shipment. The steps run in the order the architecture document
 * describes, and every line records the basis it was calculated from so an
 * invoice can be re-derived line by line during a dispute.
 */
export const priceShipment = (request: QuoteRequest, card: RateCard, now: Date = new Date()): Quote => {
  if (request.pieces.length === 0) {
    throw new PricingError('A shipment needs at least one piece', 'no_pieces');
  }

  const lane = findLane(card, request.lane, request.service);
  const pieces = request.pieces.map((p) => priceOnePiece(p, card, lane));
  const currency = card.currency;

  const volume = sumVolume(pieces.map((p) => p.volume));
  const weightGrams = pieces.reduce((sum, p) => sum + p.weightGrams, 0);
  const chargeableGrams = pieces.reduce((sum, p) => sum + p.chargeableGrams, 0);

  // ── 1. Chargeable quantity, floored at the lane minimum ──────────────────
  const isSea = request.service === 'sea_lcl';
  const rawQuantity = isSea ? volume : chargeableGrams;
  const chargeableQuantity = Math.max(rawQuantity, lane.minimumQuantity);

  const lines: QuoteLine[] = [];

  // ── 2. Freight ───────────────────────────────────────────────────────────
  // Sea: rate is per m³ and quantity is in ten-thousandths, so divide by 1e4.
  // Air: rate is per kg and quantity is in grams, so divide by 1e3.
  const freightDivisor = isSea ? 10_000 : 1_000;
  const freight = money(Math.round((lane.rate * chargeableQuantity) / freightDivisor), currency);
  const quantityLabel = isSea
    ? `${formatVolume(chargeableQuantity)} m³`
    : `${(chargeableQuantity / 1000).toFixed(1)} kg`;

  lines.push({
    code: 'freight',
    label: isSea ? 'Sea LCL freight' : 'Air express freight',
    basis: `${quantityLabel} @ ${formatMinor(lane.rate)}${
      chargeableQuantity > rawQuantity ? ' (lane minimum applied)' : ''
    }`,
    quantity: chargeableQuantity,
    unitRate: lane.rate,
    amount: freight,
  });

  // ── 3. Surcharges ────────────────────────────────────────────────────────
  const handling = money(card.surcharges.handlingPerPiece * pieces.length, currency);
  lines.push({
    code: 'handling',
    label: 'Handling and wrapping',
    basis: `${pieces.length} ${pieces.length === 1 ? 'piece' : 'pieces'} @ ${formatMinor(
      card.surcharges.handlingPerPiece,
    )}`,
    quantity: pieces.length,
    unitRate: card.surcharges.handlingPerPiece,
    amount: handling,
  });

  lines.push({
    code: 'customs_clearance',
    label: 'Destination customs clearance',
    basis: '1 shipment',
    quantity: 1,
    unitRate: card.surcharges.customsClearance,
    amount: money(card.surcharges.customsClearance, currency),
  });

  const oversizeCount = pieces.filter((p) => p.oversize).length;
  if (oversizeCount > 0) {
    lines.push({
      code: 'oversize',
      label: 'Oversize handling',
      basis: `${oversizeCount} ${oversizeCount === 1 ? 'piece' : 'pieces'} @ ${formatMinor(
        card.surcharges.oversizePiece,
      )}`,
      quantity: oversizeCount,
      unitRate: card.surcharges.oversizePiece,
      amount: money(card.surcharges.oversizePiece * oversizeCount, currency),
    });
  }

  // ── 4. Tax ───────────────────────────────────────────────────────────────
  const subtotal = addMoney(...lines.map((l) => l.amount));
  const tax = applyBasisPoints(subtotal, card.taxBasisPoints);
  lines.push({
    code: 'tax',
    label: `GST ${(card.taxBasisPoints / 100).toFixed(0)}%`,
    basis: `${(card.taxBasisPoints / 100).toFixed(0)}% of ${formatMinor(subtotal.amount)}`,
    quantity: 1,
    unitRate: null,
    amount: tax,
  });

  // ── 5. The quote, with everything needed to reproduce it ─────────────────
  return {
    rateCardVersion: card.version,
    currency,
    lane: request.lane,
    service: request.service,
    pieces,
    pieceCount: pieces.length,
    volume,
    weightGrams,
    chargeableQuantity,
    chargeableUnit: isSea ? 'm3' : 'kg',
    lines,
    subtotal,
    tax,
    total: addMoney(subtotal, tax),
    transitDaysMin: lane.transitDaysMin,
    transitDaysMax: lane.transitDaysMax,
    inputs: request,
    computedAt: now,
  };
};

const measurementsMatch = (a: Quote['pieces'][number], b: Quote['pieces'][number]): boolean =>
  a.lengthMm === b.lengthMm &&
  a.widthMm === b.widthMm &&
  a.heightMm === b.heightMm &&
  a.weightGrams === b.weightGrams;

/**
 * Compare what the customer booked against what the depot measured, and decide
 * what the business is allowed to do about it.
 *
 * This is the only place in the system that decides whether a customer gets
 * disturbed about money, so the rule lives here and nowhere else.
 */
export const assessRerate = (
  booked: Quote,
  verified: Quote,
  card: RateCard,
  now: Date = new Date(),
): RerateAssessment => {
  const difference = money(verified.total.amount - booked.total.amount, verified.currency);

  const changedPieceIndexes = verified.pieces
    .map((piece, index) => {
      const before = booked.pieces[index];
      return before && measurementsMatch(before, piece) ? -1 : index;
    })
    .filter((index) => index >= 0);

  const differenceBasisPoints =
    booked.total.amount === 0
      ? 0
      : Math.round((difference.amount / booked.total.amount) * 10_000);

  // "2% or A$10, whichever is greater" — the greater of the two, not the lesser.
  // Getting this backwards makes the system pester customers over small change,
  // which is the failure mode the tolerance exists to prevent.
  const percentageTolerance = applyBasisPoints(booked.total, card.rerateTolerance.basisPoints);
  const toleranceApplied = maxMoney(percentageTolerance, money(card.rerateTolerance.minimum, booked.currency));

  let outcome: RerateOutcome;
  if (difference.amount === 0) {
    outcome = 'unchanged';
  } else if (difference.amount < 0) {
    // Nobody is asked to approve being charged less.
    outcome = 'refund';
  } else if (difference.amount <= toleranceApplied.amount) {
    outcome = 'absorbed';
  } else if (differenceBasisPoints > card.rerateTolerance.hardStopBasisPoints) {
    outcome = 'hard_stop';
  } else {
    outcome = 'approval_required';
  }

  const autoApproveAt =
    outcome === 'approval_required'
      ? new Date(now.getTime() + card.rerateTolerance.autoApproveAfterDays * 86_400_000)
      : null;

  return {
    outcome,
    booked,
    verified,
    difference,
    differenceBasisPoints,
    toleranceApplied,
    autoApproveAt,
    changedPieceIndexes,
  };
};

/** What the customer actually owes once an assessment is settled. */
export const payableTotal = (assessment: RerateAssessment): Money =>
  assessment.outcome === 'absorbed' ? assessment.booked.total : assessment.verified.total;
