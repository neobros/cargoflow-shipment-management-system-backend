import type { RateCard } from './types.js';

/**
 * Rate card v12 — the card the UI/UX deck and the architecture document are
 * both written against. Real cards live in MongoDB and are effective-dated;
 * this one is the seed and the fixture the pricing tests run on.
 */
export const RATE_CARD_V12: RateCard = {
  version: 12,
  currency: 'AUD',
  effectiveFrom: new Date('2026-09-01T00:00:00Z'),
  effectiveTo: null,

  lanes: [
    {
      lane: 'LKCMB-AUMEL',
      service: 'sea_lcl',
      rate: 385_00,
      minimumQuantity: 1_000, // 0.10 m³ in ten-thousandths
      transitDaysMin: 18,
      transitDaysMax: 24,
    },
    {
      lane: 'LKCMB-AUSYD',
      service: 'sea_lcl',
      rate: 392_00,
      minimumQuantity: 1_000,
      transitDaysMin: 20,
      transitDaysMax: 26,
    },
    {
      lane: 'LKCMB-AUBNE',
      service: 'sea_lcl',
      rate: 410_00,
      minimumQuantity: 1_000,
      transitDaysMin: 22,
      transitDaysMax: 28,
    },
    {
      lane: 'LKCMB-AUMEL',
      service: 'air_express',
      rate: 9_80,
      minimumQuantity: 5_000, // 5 kg in grams
      volumetricDivisor: 5_000,
      transitDaysMin: 4,
      transitDaysMax: 7,
    },
    {
      lane: 'LKCMB-AUSYD',
      service: 'air_express',
      rate: 9_95,
      minimumQuantity: 5_000,
      volumetricDivisor: 5_000,
      transitDaysMin: 4,
      transitDaysMax: 7,
    },
  ],

  surcharges: {
    handlingPerPiece: 12_00,
    customsClearance: 45_00,
    originPickup: 25_00,
    remoteDelivery: 55_00,
    oversizePiece: 35_00,
    oversizeLongestSideMm: 1_200,
    oversizeWeightGrams: 45_000,
  },

  cover: {
    basisPoints: 150, // 1.5%
    minimum: 10_00,
  },

  taxBasisPoints: 1_000, // 10% GST

  rerateTolerance: {
    basisPoints: 200, // 2%
    minimum: 10_00, // or A$10, whichever is greater
    hardStopBasisPoints: 4_000, // never auto-approve a 40% jump
    autoApproveAfterDays: 14,
  },
};

/** Human labels for the lanes the customer app offers. */
export const LANES = [
  { code: 'LKCMB-AUMEL', from: 'Colombo', to: 'Melbourne' },
  { code: 'LKCMB-AUSYD', from: 'Colombo', to: 'Sydney' },
  { code: 'LKCMB-AUBNE', from: 'Colombo', to: 'Brisbane' },
] as const;

/**
 * The packaging presets the booking wizard offers. Dimensions are nominal —
 * whatever the customer picks, the depot measures the real thing on arrival.
 */
export const PACKAGING_PRESETS = [
  {
    kind: 'small_box',
    name: 'Small box',
    note: 'Books, clothes, linen',
    lengthMm: 400,
    widthMm: 300,
    heightMm: 300,
    weightGrams: 9_000,
  },
  {
    kind: 'medium_box',
    name: 'Medium box',
    note: 'Kitchenware, toys',
    lengthMm: 500,
    widthMm: 400,
    heightMm: 400,
    weightGrams: 16_000,
  },
  {
    kind: 'large_box',
    name: 'Large box',
    note: 'Our most popular size',
    lengthMm: 600,
    widthMm: 450,
    heightMm: 450,
    weightGrams: 24_000,
  },
  {
    kind: 'barrel',
    name: 'Shipping barrel',
    note: '65 litres, sealed lid',
    lengthMm: 450,
    widthMm: 450,
    heightMm: 900,
    weightGrams: 28_000,
  },
  {
    kind: 'custom_carton',
    name: 'Your own carton',
    note: 'Any size you like',
    lengthMm: 700,
    widthMm: 500,
    heightMm: 450,
    weightGrams: 31_000,
  },
  {
    kind: 'half_pallet',
    name: 'Half pallet',
    note: 'Furniture, appliances',
    lengthMm: 1_200,
    widthMm: 800,
    heightMm: 900,
    weightGrams: 180_000,
  },
] as const;
