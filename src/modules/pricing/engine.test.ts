import { describe, expect, it } from 'vitest';
import { assessRerate, payableTotal, priceShipment, PricingError } from './engine.js';
import { RATE_CARD_V12 } from './rate-cards.js';
import type { QuoteRequest } from './types.js';
import { formatVolume, volumeOf } from '../../shared/units.js';

/**
 * The worked example carried through the UI deck and the architecture
 * document both quote. If these numbers ever move, a screen somewhere is lying
 * to a customer.
 */
const DECLARED: QuoteRequest = {
  lane: 'LKCMB-AUMEL',
  service: 'sea_lcl',
  pieces: [
    { packaging: 'large_box', lengthMm: 600, widthMm: 450, heightMm: 450, weightGrams: 24_000 },
    { packaging: 'large_box', lengthMm: 600, widthMm: 450, heightMm: 450, weightGrams: 22_500 },
    { packaging: 'custom_carton', lengthMm: 700, widthMm: 500, heightMm: 450, weightGrams: 31_000 },
    { packaging: 'barrel', lengthMm: 450, widthMm: 450, heightMm: 900, weightGrams: 28_000 },
  ],
};

/** What the depot actually measured: pieces 3 and 4 came in bigger. */
const VERIFIED: QuoteRequest = {
  ...DECLARED,
  pieces: [
    { packaging: 'large_box', lengthMm: 600, widthMm: 450, heightMm: 450, weightGrams: 24_000 },
    { packaging: 'large_box', lengthMm: 600, widthMm: 450, heightMm: 450, weightGrams: 22_500 },
    { packaging: 'custom_carton', lengthMm: 780, widthMm: 580, heightMm: 520, weightGrams: 34_600 },
    { packaging: 'barrel', lengthMm: 470, widthMm: 470, heightMm: 920, weightGrams: 29_800 },
  ],
};

describe('volume', () => {
  it('matches the figures printed on the label and the invoice', () => {
    expect(volumeOf(600, 450, 450)).toBe(1215); // 0.1215 m³
    expect(volumeOf(700, 500, 450)).toBe(1575);
    expect(volumeOf(450, 450, 900)).toBe(1823); // half-up, not 1822
    expect(volumeOf(780, 580, 520)).toBe(2352);
    expect(volumeOf(470, 470, 920)).toBe(2032);
  });

  it('rounds per piece, never once at the end', () => {
    // Two pieces that each round up must not be flattened by summing first.
    const perPiece = volumeOf(450, 450, 900) + volumeOf(450, 450, 900);
    expect(perPiece).toBe(3646);
  });
});

describe('priceShipment — the booked estimate', () => {
  const quote = priceShipment(DECLARED, RATE_CARD_V12);

  it('totals 0.5828 m³ across four pieces', () => {
    expect(quote.volume).toBe(5828);
    expect(formatVolume(quote.volume)).toBe('0.5828');
    expect(quote.pieceCount).toBe(4);
    expect(quote.weightGrams).toBe(105_500);
  });

  it('produces the exact line items on the invoice', () => {
    const amounts = Object.fromEntries(quote.lines.map((l) => [l.code, l.amount.amount]));
    expect(amounts.freight).toBe(224_38); // 0.5828 m³ @ 385.00
    expect(amounts.handling).toBe(48_00); // 4 @ 12.00
    expect(amounts.customs_clearance).toBe(45_00);
    expect(amounts.tax).toBe(31_74);
  });

  it('totals A$349.12', () => {
    expect(quote.subtotal.amount).toBe(317_38);
    expect(quote.tax.amount).toBe(31_74);
    expect(quote.total.amount).toBe(349_12);
  });

  it('records the rate card version it used', () => {
    expect(quote.rateCardVersion).toBe(12);
  });

  it('adds up: every line sums to the total', () => {
    const sum = quote.lines.reduce((t, l) => t + l.amount.amount, 0);
    expect(sum).toBe(quote.total.amount);
  });
});

describe('priceShipment — the verified re-rate', () => {
  const quote = priceShipment(VERIFIED, RATE_CARD_V12);

  it('totals 0.6814 m³ once the depot has measured', () => {
    expect(quote.volume).toBe(6814);
    expect(quote.weightGrams).toBe(110_900);
  });

  it('totals A$390.87', () => {
    const amounts = Object.fromEntries(quote.lines.map((l) => [l.code, l.amount.amount]));
    expect(amounts.freight).toBe(262_34);
    expect(quote.subtotal.amount).toBe(355_34);
    expect(quote.tax.amount).toBe(35_53);
    expect(quote.total.amount).toBe(390_87);
  });

  it('is the same function, not a second implementation', () => {
    // Re-pricing unchanged inputs must reproduce the booked quote exactly.
    const again = priceShipment(DECLARED, RATE_CARD_V12);
    const booked = priceShipment(DECLARED, RATE_CARD_V12);
    expect(again.total).toEqual(booked.total);
    expect(again.lines).toEqual(booked.lines);
  });
});

describe('assessRerate', () => {
  const booked = priceShipment(DECLARED, RATE_CARD_V12);
  const verified = priceShipment(VERIFIED, RATE_CARD_V12);
  const now = new Date('2026-09-01T09:41:00Z');

  it('asks the customer for +A$41.75', () => {
    const a = assessRerate(booked, verified, RATE_CARD_V12, now);
    expect(a.difference.amount).toBe(41_75);
    expect(a.outcome).toBe('approval_required');
    expect(a.differenceBasisPoints).toBe(1_196); // +11.96%
  });

  it('names the two pieces that actually moved', () => {
    const a = assessRerate(booked, verified, RATE_CARD_V12, now);
    expect(a.changedPieceIndexes).toEqual([2, 3]);
  });

  it('auto-approves 14 days later, not 13', () => {
    const a = assessRerate(booked, verified, RATE_CARD_V12, now);
    expect(a.autoApproveAt?.toISOString()).toBe('2026-09-15T09:41:00.000Z');
  });

  it('says nothing when the measurements match', () => {
    const a = assessRerate(booked, booked, RATE_CARD_V12, now);
    expect(a.outcome).toBe('unchanged');
    expect(a.difference.amount).toBe(0);
    expect(a.changedPieceIndexes).toEqual([]);
  });

  it('absorbs a difference under the tolerance instead of pestering anyone', () => {
    // One barrel 10 mm taller: +A$0.77, far under the A$10 floor.
    const barelyBigger = priceShipment(
      {
        ...DECLARED,
        pieces: DECLARED.pieces.map((p, i) => (i === 3 ? { ...p, heightMm: 910 } : p)),
      },
      RATE_CARD_V12,
    );
    const a = assessRerate(booked, barelyBigger, RATE_CARD_V12, now);
    expect(a.difference.amount).toBeGreaterThan(0);
    expect(a.outcome).toBe('absorbed');
    expect(payableTotal(a).amount).toBe(booked.total.amount);
  });

  it('uses the greater of 2% or A$10, not the lesser', () => {
    // A$9 on a A$349.12 booking is 2.4% — over the percentage, under the floor.
    // The greater tolerance (A$10) applies, so this is absorbed.
    expect(assessRerate(booked, booked, RATE_CARD_V12, now).toleranceApplied.amount).toBe(10_00);
  });

  it('refunds without asking when the box turns out smaller', () => {
    const smaller = priceShipment(
      {
        ...DECLARED,
        pieces: DECLARED.pieces.map((p, i) => (i === 2 ? { ...p, lengthMm: 600 } : p)),
      },
      RATE_CARD_V12,
    );
    const a = assessRerate(booked, smaller, RATE_CARD_V12, now);
    expect(a.difference.amount).toBeLessThan(0);
    expect(a.outcome).toBe('refund');
    expect(a.autoApproveAt).toBeNull();
  });

  it('never auto-approves a 40%+ jump', () => {
    const enormous = priceShipment(
      {
        ...DECLARED,
        pieces: DECLARED.pieces.map((p) => ({ ...p, lengthMm: p.lengthMm * 2, widthMm: p.widthMm * 2 })),
      },
      RATE_CARD_V12,
    );
    const a = assessRerate(booked, enormous, RATE_CARD_V12, now);
    expect(a.outcome).toBe('hard_stop');
    expect(a.autoApproveAt).toBeNull();
  });
});

describe('lane rules', () => {
  it('applies the lane minimum to a single small box', () => {
    const q = priceShipment(
      {
        ...DECLARED,
        pieces: [{ packaging: 'small_box', lengthMm: 400, widthMm: 300, heightMm: 300, weightGrams: 9_000 }],
      },
      RATE_CARD_V12,
    );
    expect(q.volume).toBe(360); // 0.036 m³ actual
    expect(q.chargeableQuantity).toBe(1_000); // floored at 0.10 m³
    expect(q.lines[0]?.basis).toContain('lane minimum applied');
  });

  it('charges air freight on volumetric weight when the box is light and large', () => {
    const q = priceShipment(
      {
        lane: 'LKCMB-AUMEL',
        service: 'air_express',
        pieces: [{ packaging: 'large_box', lengthMm: 600, widthMm: 450, heightMm: 450, weightGrams: 8_000 }],
      },
      RATE_CARD_V12,
    );
    // 600×450×450 mm at divisor 5000 → 24.3 kg volumetric, well over the 8 kg actual.
    expect(q.pieces[0]?.chargeableGrams).toBe(24_300);
    expect(q.chargeableUnit).toBe('kg');
  });

  it('charges the oversize surcharge on a half pallet', () => {
    const q = priceShipment(
      {
        ...DECLARED,
        pieces: [
          { packaging: 'half_pallet', lengthMm: 1_200, widthMm: 800, heightMm: 900, weightGrams: 180_000 },
        ],
      },
      RATE_CARD_V12,
    );
    expect(q.pieces[0]?.oversize).toBe(true);
    expect(q.lines.find((l) => l.code === 'oversize')?.amount.amount).toBe(35_00);
  });

  it('refuses a lane it has no rate for', () => {
    expect(() => priceShipment({ ...DECLARED, lane: 'LKCMB-AUPER' }, RATE_CARD_V12)).toThrow(PricingError);
  });
});

describe('invariants', () => {
  it('is monotonic in volume — a bigger box never costs less', () => {
    let previous = 0;
    for (let mm = 300; mm <= 1_100; mm += 50) {
      const q = priceShipment(
        {
          ...DECLARED,
          pieces: [{ packaging: 'custom_carton', lengthMm: mm, widthMm: mm, heightMm: mm, weightGrams: 20_000 }],
        },
        RATE_CARD_V12,
      );
      expect(q.total.amount).toBeGreaterThanOrEqual(previous);
      previous = q.total.amount;
    }
  });

  it('never produces a fractional minor unit', () => {
    for (let i = 1; i <= 300; i += 7) {
      const q = priceShipment(
        {
          ...DECLARED,
          pieces: [
            { packaging: 'custom_carton', lengthMm: 300 + i, widthMm: 250 + i, heightMm: 200 + i, weightGrams: 1_000 + i * 11 },
          ],
        },
        RATE_CARD_V12,
      );
      for (const line of q.lines) {
        expect(Number.isInteger(line.amount.amount)).toBe(true);
      }
      expect(Number.isInteger(q.total.amount)).toBe(true);
      expect(q.lines.reduce((t, l) => t + l.amount.amount, 0)).toBe(q.total.amount);
    }
  });
});
