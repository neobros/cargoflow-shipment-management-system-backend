import { COLLECTIONS, collection } from '../../db/mongo.js';
import { RATE_CARD_V12 } from './rate-cards.js';
import type { RateCard } from './types.js';

/**
 * Rate cards are effective-dated documents, never edited in place. A booking
 * keeps the version it was quoted on for the life of the shipment, so
 * publishing a new card cannot change what an existing customer owes.
 */
export const getActiveRateCard = async (at: Date = new Date()): Promise<RateCard> => {
  const found = await collection<RateCard>(COLLECTIONS.rateCards).findOne(
    {
      effectiveFrom: { $lte: at },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }],
    },
    { sort: { effectiveFrom: -1 }, projection: { _id: 0 } },
  );

  // The seeded card is also the compiled-in fallback, so the pricing engine is
  // never the reason the API is down.
  return found ?? RATE_CARD_V12;
};

/** Fetch a specific version — used when re-pricing an existing booking. */
export const getRateCardVersion = async (version: number): Promise<RateCard | null> =>
  collection<RateCard>(COLLECTIONS.rateCards).findOne({ version }, { projection: { _id: 0 } });

export const saveRateCard = async (card: RateCard): Promise<void> => {
  await collection<RateCard>(COLLECTIONS.rateCards).updateOne(
    { version: card.version },
    { $set: card },
    { upsert: true },
  );
};
