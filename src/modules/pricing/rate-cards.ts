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
    oversizePiece: 35_00,
    oversizeLongestSideMm: 1_200,
    oversizeWeightGrams: 45_000,
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
/**
 * A lane is a port pair, and it carries the two countries as well as the two
 * cities. The countries are what addresses are checked against: a lane that
 * arrives in Australia cannot deliver to a Sri Lankan suburb, and catching
 * that at booking is far cheaper than catching it at the container door.
 */
export const LANES = [
  { code: 'LKCMB-AUMEL', from: 'Colombo', fromCountry: 'LK', to: 'Melbourne', toCountry: 'AU' },
  { code: 'LKCMB-AUSYD', from: 'Colombo', fromCountry: 'LK', to: 'Sydney', toCountry: 'AU' },
  { code: 'LKCMB-AUBNE', from: 'Colombo', fromCountry: 'LK', to: 'Brisbane', toCountry: 'AU' },
] as const;

/**
 * The packaging presets the booking wizard offers. Dimensions are nominal —
 * whatever the customer picks, the depot measures the real thing on arrival.
 */
/**
 * The one packaging kind whose dimensions the customer supplies. Everything
 * else is a box we hand them, at a size we already know.
 */
export const CUSTOM_PACKAGING = 'custom_carton';

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
    kind: 'half_pallet',
    name: 'Half pallet',
    note: 'Furniture, appliances',
    lengthMm: 1_200,
    widthMm: 800,
    heightMm: 900,
    weightGrams: 180_000,
  },
  {
    kind: 'custom_carton',
    // The `kind` is the stored enum and never changes. The name is what a
    // customer reads, and "custom" is the word the brief itself uses.
    name: 'Custom size',
    note: 'Any box — you enter the measurements',
    lengthMm: 700,
    widthMm: 500,
    heightMm: 450,
    weightGrams: 31_000,
  },
] as const;

/**
 * Make a declared shipment consistent with the boxes it names.
 *
 * If someone says "medium box", they are charged for a medium box — the
 * dimensions come from the preset, not from the request. The browser makes
 * those fields read-only, but a form control is a courtesy and this is the
 * control: it closes the gap where a crafted request declares a large box at a
 * small box's dimensions and pays the smaller price until the depot catches it.
 *
 * Declared measurements only. What the depot puts on the scale is the real
 * box and is never rewritten — that disagreement is the whole point of
 * re-rating.
 */
export const normaliseDeclared = <T extends {
  packaging: string;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}>(
  pieces: T[],
): T[] =>
  pieces.map((piece) => {
    if (piece.packaging === CUSTOM_PACKAGING) return piece;
    const preset = PACKAGING_PRESETS.find((candidate) => candidate.kind === piece.packaging);
    if (!preset) return piece;
    return {
      ...piece,
      lengthMm: preset.lengthMm,
      widthMm: preset.widthMm,
      heightMm: preset.heightMm,
    };
  });
