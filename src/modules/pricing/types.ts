import { z } from 'zod';
import type { Currency, Minor, Money, Volume4 } from '../../shared/units.js';

/** Sea consolidation is priced on space, air on weight. */
export const ServiceMode = z.enum(['sea_lcl', 'air_express']);
export type ServiceMode = z.infer<typeof ServiceMode>;

export const PackagingKind = z.enum([
  'small_box',
  'medium_box',
  'large_box',
  'barrel',
  'custom_carton',
  'half_pallet',
]);
export type PackagingKind = z.infer<typeof PackagingKind>;

/**
 * One physical box as the customer describes it, or as the depot measures it.
 * The engine cannot tell the difference — which is exactly why re-rating is
 * the same code path as quoting.
 */
export const PieceInput = z.object({
  packaging: PackagingKind,
  lengthMm: z.number().int().positive().max(3_000),
  widthMm: z.number().int().positive().max(3_000),
  heightMm: z.number().int().positive().max(3_000),
  weightGrams: z.number().int().positive().max(1_000_000),
});
export type PieceInput = z.infer<typeof PieceInput>;

export const QuoteRequest = z.object({
  lane: z.string().min(3),
  service: ServiceMode,
  pieces: z.array(PieceInput).min(1).max(60),
});
export type QuoteRequest = z.infer<typeof QuoteRequest>;

/**
 * A rate card is data, never code, and it is effective-dated. A booking keeps
 * the version it was quoted on for the life of the shipment, so publishing a
 * new card can never change what an existing customer owes.
 */
export interface LaneRate {
  lane: string;
  service: ServiceMode;
  /** Per m³ for sea, per chargeable kg for air. */
  rate: Minor;
  /** Sea: minimum billable volume. Air: minimum chargeable weight in grams. */
  minimumQuantity: number;
  /** Air only. */
  volumetricDivisor?: number;
  transitDaysMin: number;
  transitDaysMax: number;
}

export interface RateCard {
  version: number;
  currency: Currency;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  lanes: LaneRate[];
  surcharges: {
    handlingPerPiece: Minor;
    customsClearance: Minor;
    oversizePiece: Minor;
    /** A piece over either threshold attracts the oversize surcharge. */
    oversizeLongestSideMm: number;
    oversizeWeightGrams: number;
  };
  /** Basis points. 1000 = 10% GST. */
  taxBasisPoints: number;
  /**
   * A verified measurement only changes the price when it clears BOTH of
   * these — whichever is greater. Below that the difference is absorbed and
   * nobody is disturbed.
   */
  rerateTolerance: {
    basisPoints: number;
    minimum: Minor;
    /** Never auto-approve above this. An agent has to make a phone call. */
    hardStopBasisPoints: number;
    autoApproveAfterDays: number;
  };
}

export interface QuoteLine {
  code:
    | 'freight'
    | 'handling'
    | 'customs_clearance'
    | 'origin_pickup'
    | 'remote_delivery'
    | 'oversize'
    | 'cover'
    | 'tax';
  label: string;
  /** Human-readable basis, e.g. "0.6814 m³ @ 385.00". */
  basis: string;
  quantity: number;
  unitRate: Minor | null;
  amount: Money;
}

export interface PricedPiece {
  packaging: PackagingKind;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  weightGrams: number;
  volume: Volume4;
  /** Air only: max(actual, volumetric). */
  chargeableGrams: number;
  oversize: boolean;
}

export interface Quote {
  rateCardVersion: number;
  currency: Currency;
  lane: string;
  service: ServiceMode;
  pieces: PricedPiece[];
  pieceCount: number;
  /** Sum of per-piece volumes, before the lane minimum is applied. */
  volume: Volume4;
  weightGrams: number;
  /** What freight is actually charged on, after the lane minimum. */
  chargeableQuantity: number;
  chargeableUnit: 'm3' | 'kg';
  lines: QuoteLine[];
  subtotal: Money;
  tax: Money;
  total: Money;
  transitDaysMin: number;
  transitDaysMax: number;
  /** Everything needed to reproduce this quote byte for byte. */
  inputs: QuoteRequest;
  computedAt: Date;
}

export type RerateOutcome = 'unchanged' | 'absorbed' | 'approval_required' | 'hard_stop' | 'refund';

export interface RerateAssessment {
  outcome: RerateOutcome;
  booked: Quote;
  verified: Quote;
  difference: Money;
  differenceBasisPoints: number;
  toleranceApplied: Money;
  /** Only meaningful when approval is required. */
  autoApproveAt: Date | null;
  /** Pieces whose measurements actually moved. */
  changedPieceIndexes: number[];
}
