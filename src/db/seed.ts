import { COLLECTIONS, collection } from './mongo.js';
import { RATE_CARD_V12 } from '../modules/pricing/rate-cards.js';
import { saveRateCard } from '../modules/pricing/repository.js';
import type { RateCard } from '../modules/pricing/types.js';

/**
 * Draft v13 — a future card, so the admin panel has something real to show in
 * its version history and so the effective-dating logic is exercised from day
 * one rather than the first time a rate actually changes.
 */
const RATE_CARD_V13_DRAFT: RateCard = {
  ...RATE_CARD_V12,
  version: 13,
  effectiveFrom: new Date('2026-10-01T00:00:00Z'),
  lanes: RATE_CARD_V12.lanes.map((lane) =>
    lane.lane === 'LKCMB-AUMEL' && lane.service === 'sea_lcl' ? { ...lane, rate: 396_00 } : lane,
  ),
  surcharges: { ...RATE_CARD_V12.surcharges, oversizeLongestSideMm: 1_100 },
};

export const seedRateCards = async (): Promise<void> => {
  const existing = await collection(COLLECTIONS.rateCards).countDocuments();
  if (existing > 0) return;

  // v12 is live; v13 takes over on 01 Oct. Bookings quoted today keep v12
  // forever, which is the whole point of versioning them.
  await saveRateCard({ ...RATE_CARD_V12, effectiveTo: RATE_CARD_V13_DRAFT.effectiveFrom });
  await saveRateCard(RATE_CARD_V13_DRAFT);
};

/** `npm run seed` — safe to run repeatedly. */
const main = async (): Promise<void> => {
  const { connectToDatabase, closeDatabase, ensureIndexes, ensureTimeSeriesCollections } = await import('./mongo.js');
  const connection = await connectToDatabase();
  if (connection.inMemory) {
    console.error('Refusing to seed an in-memory database — set MONGODB_URI first.');
    await closeDatabase();
    process.exit(1);
  }
  await ensureTimeSeriesCollections();
  await ensureIndexes();
  await seedRateCards();
  console.log(`Seeded rate cards into ${connection.database}`);
  await closeDatabase();
};

// Only run when invoked directly, not when imported by the server.
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  void main();
}
