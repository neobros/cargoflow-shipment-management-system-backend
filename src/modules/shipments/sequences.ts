import { COLLECTIONS, collection } from '../../db/mongo.js';

/**
 * Human-facing reference numbers.
 *
 * Customers read these down a phone line and write them on boxes in marker, so
 * they cannot be ObjectIds. They also cannot be `count() + 1` — two operators
 * scanning at the same moment would both read the same count and mint the same
 * tracking ID, and the unique index would reject the loser after the physical
 * label was already printed.
 *
 * `findOneAndUpdate` with `$inc` is atomic inside the server: every caller gets
 * a distinct number, whatever else is happening.
 */
interface CounterDoc {
  _id: string;
  value: number;
}

const counters = () => collection<CounterDoc>(COLLECTIONS.counters);

const nextValue = async (name: string): Promise<number> => {
  const result = await counters().findOneAndUpdate(
    { _id: name },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  if (!result) throw new Error(`Counter ${name} did not return a value`);
  return result.value;
};

const yy = (at: Date) => String(at.getUTCFullYear()).slice(2);

/** BK-26-0001 — the number on the confirmation email. */
export const nextBookingReference = async (at = new Date()): Promise<string> => {
  const n = await nextValue(`booking-${at.getUTCFullYear()}`);
  return `BK-${yy(at)}-${String(n).padStart(4, '0')}`;
};

/**
 * CF-0001-001 — booking digits, then the piece's position within it.
 *
 * Deriving it from the booking reference means a label found on a warehouse
 * floor identifies its shipment without a database, and the sequence is stable
 * whichever order the boxes are scanned in.
 */
export const trackingIdFor = (bookingReference: string, sequence: number): string => {
  const digits = bookingReference.replace(/[^0-9]/g, '').slice(-4);
  return `CF-${digits}-${String(sequence).padStart(3, '0')}`;
};

/** CF-04412 — the customer account, reused across their bookings. */
export const nextCustomerReference = async (): Promise<string> => {
  const n = await nextValue('customer');
  return `CF-${String(n).padStart(5, '0')}`;
};

/** ADJ-2026-00318 — a price change awaiting a decision. */
export const nextAdjustmentReference = async (at = new Date()): Promise<string> => {
  const n = await nextValue(`adjustment-${at.getUTCFullYear()}`);
  return `ADJ-${at.getUTCFullYear()}-${String(n).padStart(5, '0')}`;
};

/** INV-2026-01184 — appears on the customer's invoice and in their bank statement. */
export const nextInvoiceNumber = async (at = new Date()): Promise<string> => {
  const n = await nextValue(`invoice-${at.getUTCFullYear()}`);
  return `INV-${at.getUTCFullYear()}-${String(n).padStart(5, '0')}`;
};

/**
 * CFLU 482 9317 — ISO 6346 shape: four-letter owner code, six digits, check
 * digit. Real containers are leased and their numbers come from the line, so
 * this only mints numbers for containers we open ourselves.
 */
export const nextContainerNumber = async (): Promise<string> => {
  const n = await nextValue('container');
  const serial = String(400_000 + n).padStart(6, '0');
  return `CFLU ${serial.slice(0, 3)} ${serial.slice(3)}`;
};

/** BOL-2026-00047 — one master bill per container. */
export const nextBolNumber = async (at = new Date()): Promise<string> => {
  const n = await nextValue(`bol-${at.getUTCFullYear()}`);
  return `BOL-${at.getUTCFullYear()}-${String(n).padStart(5, '0')}`;
};
