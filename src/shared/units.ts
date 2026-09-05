/**
 * Every physical quantity in CargoFlow is an integer. Floats never touch a
 * measurement or a price, because a tenth of a cent lost in a rounding path is
 * a tenth of a cent a customer will eventually find.
 *
 *   length  → millimetres            (600 mm, not 60 cm, not 0.6 m)
 *   mass    → grams                  (24_000 g, not 24 kg)
 *   volume  → ten-thousandths of m³  (1215 → 0.1215 m³)
 *   money   → minor units            (37_882 → A$378.82)
 */

/** Ten-thousandths of a cubic metre. 1215 means 0.1215 m³. */
export type Volume4 = number;

/** Minor currency units. 37882 means 378.82. */
export type Minor = number;

export type Currency = 'AUD' | 'LKR';

export interface Money {
  readonly amount: Minor;
  readonly currency: Currency;
}

export const money = (amount: Minor, currency: Currency = 'AUD'): Money => ({
  amount: Math.round(amount),
  currency,
});

export const addMoney = (...values: Money[]): Money => {
  const first = values[0];
  if (!first) return money(0);
  for (const v of values) {
    if (v.currency !== first.currency) {
      throw new Error(`Cannot add ${v.currency} to ${first.currency}`);
    }
  }
  return money(
    values.reduce((sum, v) => sum + v.amount, 0),
    first.currency,
  );
};

/** Multiply money by a rate expressed in basis points (10000 = 100%). */
export const applyBasisPoints = (value: Money, basisPoints: number): Money =>
  money(Math.round((value.amount * basisPoints) / 10_000), value.currency);

export const maxMoney = (a: Money, b: Money): Money => (a.amount >= b.amount ? a : b);

/** "378.82" — no currency symbol, no thousands separators. For logs and APIs. */
export const formatMinor = (amount: Minor): string => (amount / 100).toFixed(2);

/** "A$378.82" — for humans. */
export const formatMoney = ({ amount, currency }: Money): string => {
  const symbol = currency === 'AUD' ? 'A$' : 'Rs ';
  const body = (Math.abs(amount) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${amount < 0 ? '−' : ''}${symbol}${body}`;
};

/**
 * Volume of one piece from its millimetre dimensions.
 *
 * mm³ / 1e9 = m³, and we want ten-thousandths, so mm³ / 1e5. The intermediate
 * is an exact integer for any realistic box, so the only rounding is the final
 * half-up — which is what the customer sees on their quote.
 */
export const volumeOf = (lengthMm: number, widthMm: number, heightMm: number): Volume4 =>
  Math.round((lengthMm * widthMm * heightMm) / 100_000);

/** Sum per-piece volumes. Rounding happens per piece, never at the end. */
export const sumVolume = (volumes: Volume4[]): Volume4 =>
  volumes.reduce((total, v) => total + v, 0);

/** "0.6814" */
export const formatVolume = (v: Volume4): string => (v / 10_000).toFixed(4);

/**
 * Volumetric weight for air freight, in grams.
 *
 * The industry formula is cm³ / divisor = kilograms. Working in millimetres:
 *   cm³      = mm³ / 1_000
 *   kg       = cm³ / divisor
 *   grams    = kg × 1_000
 * which collapses to mm³ / divisor. A 600×450×450 mm box at divisor 5000 is
 * 24_300 g — 24.3 kg of chargeable weight against 8 kg of actual weight.
 */
export const volumetricGrams = (
  lengthMm: number,
  widthMm: number,
  heightMm: number,
  divisor: number,
): number => Math.round((lengthMm * widthMm * heightMm) / divisor);

/** "24.0" */
export const formatKg = (grams: number): string => (grams / 1000).toFixed(1);

export const cmToMm = (cm: number): number => Math.round(cm * 10);
export const mmToCm = (mm: number): number => mm / 10;
export const kgToGrams = (kg: number): number => Math.round(kg * 1000);
