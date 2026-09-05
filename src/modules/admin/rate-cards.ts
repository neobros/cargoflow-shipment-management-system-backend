import { z } from 'zod';
import { COLLECTIONS, collection } from '../../db/mongo.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { formatMinor, formatVolume } from '../../shared/units.js';
import { LANES } from '../pricing/rate-cards.js';
import { saveRateCard } from '../pricing/repository.js';
import type { RateCard } from '../pricing/types.js';
import type { BookingDoc } from '../shipments/types.js';

const cards = () => collection<RateCard>(COLLECTIONS.rateCards);
const bookings = () => collection<BookingDoc>(COLLECTIONS.bookings);

/**
 * Rate cards are versioned documents, never edited in place.
 *
 * A booking keeps the version it was quoted on for the life of the shipment, so
 * publishing a new card cannot change what an existing customer owes. That is
 * the whole reason this screen publishes rather than edits: an editable rate
 * would silently rewrite history for every unsettled shipment on the floor.
 */

export type CardState = 'expired' | 'live' | 'scheduled';

export interface RateCardSummary {
  version: number;
  currency: string;
  state: CardState;
  effectiveFrom: string;
  effectiveTo: string | null;
  laneCount: number;
  /** How many bookings were quoted on it — a card in use cannot be withdrawn. */
  bookingsQuoted: number;
  lanes: {
    lane: string;
    route: string;
    service: string;
    rate: string;
    unit: string;
    minimum: string;
    transit: string;
  }[];
  surcharges: { label: string; amount: string }[];
  taxPercent: string;
  tolerance: { percent: string; minimum: string; hardStopPercent: string; autoApproveDays: number };
}

const stateOf = (card: RateCard, at: Date): CardState => {
  if (card.effectiveFrom > at) return 'scheduled';
  if (card.effectiveTo && card.effectiveTo <= at) return 'expired';
  return 'live';
};

const SURCHARGE_LABELS: Record<string, string> = {
  handlingPerPiece: 'Handling and wrapping, each box',
  customsClearance: 'Destination customs clearance, each shipment',
  oversizePiece: 'Oversize piece',
};

const present = async (card: RateCard, at: Date): Promise<RateCardSummary> => ({
  version: card.version,
  currency: card.currency,
  state: stateOf(card, at),
  effectiveFrom: card.effectiveFrom.toISOString(),
  effectiveTo: card.effectiveTo?.toISOString() ?? null,
  laneCount: card.lanes.length,
  bookingsQuoted: await bookings().countDocuments({ 'bookedQuote.rateCardVersion': card.version }),
  lanes: card.lanes.map((lane) => {
    const known = LANES.find((l) => l.code === lane.lane);
    const sea = lane.service === 'sea_lcl';
    return {
      lane: lane.lane,
      route: known ? `${known.from} → ${known.to}` : lane.lane,
      service: sea ? 'Sea LCL' : 'Air express',
      rate: formatMinor(lane.rate),
      unit: sea ? 'm³' : 'kg',
      minimum: sea
        ? `${(lane.minimumQuantity / 10_000).toFixed(2)} m³`
        : `${lane.minimumQuantity / 1000} kg`,
      transit: `${lane.transitDaysMin}–${lane.transitDaysMax} days`,
    };
  }),
  surcharges: Object.entries(card.surcharges)
    // The oversize thresholds are dimensions, not money, and belong with the
    // rule rather than in a column of prices.
    .filter(([key]) => key in SURCHARGE_LABELS)
    .map(([key, value]) => ({ label: SURCHARGE_LABELS[key]!, amount: formatMinor(value as number) })),
  taxPercent: (card.taxBasisPoints / 100).toFixed(0),
  tolerance: {
    percent: (card.rerateTolerance.basisPoints / 100).toFixed(1),
    minimum: formatMinor(card.rerateTolerance.minimum),
    hardStopPercent: (card.rerateTolerance.hardStopBasisPoints / 100).toFixed(0),
    autoApproveDays: card.rerateTolerance.autoApproveAfterDays,
  },
});

export const listRateCards = async (): Promise<{ cards: RateCardSummary[] }> => {
  const at = new Date();
  const all = await cards().find({}, { projection: { _id: 0 } }).sort({ version: -1 }).toArray();
  return { cards: await Promise.all(all.map((card) => present(card, at))) };
};

/**
 * Publish a new version.
 *
 * Takes the rates that changed rather than a whole card: everything unstated is
 * carried forward from the version being superseded, because a form that makes
 * someone retype eighteen unchanged numbers is a form that eventually gets one
 * of them wrong.
 */
export const PublishRateCard = z.object({
  /** Which version this is based on. Defaults to the newest. */
  basedOn: z.number().int().positive().optional(),
  effectiveFrom: z.string().datetime(),
  lanes: z
    .array(
      z.object({
        lane: z.string().min(3),
        service: z.enum(['sea_lcl', 'air_express']),
        /** Minor units. 39600 is A$396.00 per m³. */
        rate: z.number().int().positive().max(100_000_00),
      }),
    )
    .default([]),
  surcharges: z
    .object({
      handlingPerPiece: z.number().int().min(0).max(1_000_00).optional(),
      customsClearance: z.number().int().min(0).max(10_000_00).optional(),
      oversizePiece: z.number().int().min(0).max(10_000_00).optional(),
    })
    .default({}),
});
export type PublishRateCard = z.infer<typeof PublishRateCard>;

export const publishRateCard = async (input: PublishRateCard): Promise<RateCardSummary> => {
  const all = await cards().find({}, { projection: { _id: 0 } }).sort({ version: -1 }).toArray();
  const base = input.basedOn ? all.find((c) => c.version === input.basedOn) : all[0];
  if (!base) throw notFound(`Rate card v${input.basedOn ?? ''}`, 'rate_card_not_found');

  const effectiveFrom = new Date(input.effectiveFrom);

  // A card that starts before the one it supersedes would leave two live at
  // once, and `getActiveRateCard` would pick whichever sorted first.
  if (effectiveFrom <= base.effectiveFrom) {
    throw badRequest(
      `A new card has to start after v${base.version}, which runs from ${base.effectiveFrom.toDateString()}`,
      'effective_from_too_early',
    );
  }
  if (effectiveFrom <= new Date()) {
    throw badRequest(
      'A rate card takes effect in the future. Backdating one would change what shipments already quoted are worth.',
      'effective_from_in_past',
    );
  }

  const version = Math.max(...all.map((c) => c.version)) + 1;

  const lanes = base.lanes.map((lane) => {
    const change = input.lanes.find((l) => l.lane === lane.lane && l.service === lane.service);
    return change ? { ...lane, rate: change.rate } : lane;
  });

  const unknown = input.lanes.find(
    (l) => !base.lanes.some((lane) => lane.lane === l.lane && lane.service === l.service),
  );
  if (unknown) {
    throw badRequest(
      `v${base.version} has no ${unknown.service} rate for ${unknown.lane}`,
      'unknown_lane_service',
    );
  }

  const card: RateCard = {
    ...base,
    version,
    effectiveFrom,
    effectiveTo: null,
    lanes,
    surcharges: { ...base.surcharges, ...input.surcharges },
  };

  const clash = all.find((c) => c.version === version);
  if (clash) throw conflict(`Version ${version} already exists`, 'version_exists');

  // The card being superseded stops the moment the new one starts. Without
  // this the old one stays open-ended and two cards claim the same day.
  await cards().updateOne({ version: base.version }, { $set: { effectiveTo: effectiveFrom } });
  await saveRateCard(card);

  return present(card, new Date());
};

/** What the "what changes" preview shows before anyone publishes. */
export const compareToLive = async (input: PublishRateCard) => {
  const all = await cards().find({}, { projection: { _id: 0 } }).sort({ version: -1 }).toArray();
  const base = input.basedOn ? all.find((c) => c.version === input.basedOn) : all[0];
  if (!base) throw notFound('Rate card', 'rate_card_not_found');

  return {
    basedOn: base.version,
    changes: input.lanes
      .map((change) => {
        const lane = base.lanes.find((l) => l.lane === change.lane && l.service === change.service);
        if (!lane) return null;
        const known = LANES.find((l) => l.code === change.lane);
        return {
          route: known ? `${known.from} → ${known.to}` : change.lane,
          service: change.service === 'sea_lcl' ? 'Sea LCL' : 'Air express',
          from: formatMinor(lane.rate),
          to: formatMinor(change.rate),
          movePercent: (((change.rate - lane.rate) / lane.rate) * 100).toFixed(1),
        };
      })
      .filter(Boolean),
  };
};

/** Volume is shown in m³ on this screen; the helper keeps the units honest. */
export const asVolume = formatVolume;
