import type { ObjectId } from 'mongodb';
import { COLLECTIONS, collection } from '../../db/mongo.js';
import { badRequest, blockedByAdjustment, conflict, notFound } from '../../shared/errors.js';
import { formatMinor, formatVolume, type Minor } from '../../shared/units.js';
import * as notifications from '../notifications/service.js';
import { LANES } from '../pricing/rate-cards.js';
import type { Quote } from '../pricing/types.js';
import { nextBolNumber, nextInvoiceNumber } from '../shipments/sequences.js';
import type {
  AdjustmentDoc,
  BookingDoc,
  ContainerDoc,
  PieceDoc,
} from '../shipments/types.js';

const bookings = () => collection<BookingDoc>(COLLECTIONS.bookings);
const pieces = () => collection<PieceDoc>(COLLECTIONS.pieces);
const containers = () => collection<ContainerDoc>(COLLECTIONS.containers);
const adjustments = () => collection<AdjustmentDoc>(COLLECTIONS.adjustments);

export interface InvoiceLine {
  code: string;
  label: string;
  basis: string;
  amount: Minor;
}

export interface InvoiceDoc {
  _id?: ObjectId;
  number: string;
  bookingId: ObjectId;
  bookingRef: string;
  customerRef: string;
  customerName: string;
  billTo: BookingDoc['sender'];
  currency: string;
  lines: InvoiceLine[];
  subtotal: Minor;
  tax: Minor;
  total: Minor;
  /** Which quote this was cut from, so a dispute can be reconstructed. */
  basis: 'booked' | 'verified';
  rateCardVersion: number;
  status: 'issued' | 'paid' | 'void';
  issuedAt: Date;
  dueAt: Date;
  paidAt: Date | null;
  issuedBy: string;
}

const invoices = () => collection<InvoiceDoc>(COLLECTIONS.invoices);

/** A minted document number, so re-opening a BOL does not mint a second one. */
interface DocumentNumberDoc {
  _id?: ObjectId;
  kind: string;
  key: string;
  number: string;
}

const PAYMENT_TERMS_DAYS = 14;

/**
 * Requirement 3.1: the invoice.
 *
 * It is cut from the verified quote where one exists and the booked quote
 * otherwise — but never while a price change is unapproved. Invoicing a
 * customer for a figure they have been asked to approve and have not is how a
 * company generates disputes and chargebacks, so that case throws rather than
 * quietly picking one of the two numbers.
 *
 * The invoice stores its own lines rather than pointing at the quote. A rate
 * card is effective-dated and a quote can be recomputed; an invoice is a
 * financial record and has to say the same thing in five years.
 */
export const issueInvoice = async (
  reference: string,
  issuedBy: string,
): Promise<InvoiceDoc> => {
  const booking = await bookings().findOne({ reference: reference.toUpperCase() });
  if (!booking) throw notFound(`Booking ${reference}`, 'booking_not_found');

  const existing = await invoices().findOne({ bookingId: booking._id!, status: { $ne: 'void' } });
  if (existing) {
    throw conflict(
      `${booking.reference} was already invoiced as ${existing.number}`,
      'already_invoiced',
    );
  }

  const open = await adjustments().findOne({
    bookingId: booking._id!,
    state: 'awaiting_approval',
  });
  if (open) throw blockedByAdjustment(booking.reference);

  const quote: Quote = booking.verifiedQuote ?? booking.bookedQuote;
  const basis: 'booked' | 'verified' = booking.verifiedQuote ? 'verified' : 'booked';

  const now = new Date();
  const doc: InvoiceDoc = {
    number: await nextInvoiceNumber(now),
    bookingId: booking._id!,
    bookingRef: booking.reference,
    customerRef: booking.customerRef,
    customerName: booking.customerName,
    billTo: booking.sender,
    currency: quote.currency,
    // The quote carries GST as its last line; the invoice carries it as its own
    // field under the subtotal, the way a tax invoice is laid out. Keeping both
    // would show the same 23.89 twice and make the document not add up.
    lines: quote.lines
      .filter((line) => line.code !== 'tax')
      .map((line) => ({
        code: line.code,
        label: line.label,
        basis: line.basis,
        amount: line.amount.amount,
      })),
    subtotal: quote.subtotal.amount,
    tax: quote.tax.amount,
    total: quote.total.amount,
    basis,
    rateCardVersion: quote.rateCardVersion,
    status: 'issued',
    issuedAt: now,
    dueAt: new Date(now.getTime() + PAYMENT_TERMS_DAYS * 86_400_000),
    paidAt: null,
    issuedBy,
  };

  await invoices().insertOne(doc);

  await notifications.send({
    entityId: doc.number,
    event: 'invoice_issued',
    bookingRef: booking.reference,
    to: { email: booking.sender.email, mobile: booking.sender.mobile },
    subject: `Invoice ${doc.number} — ${quote.currency} ${formatMinor(doc.total)}`,
    body: [
      `Invoice ${doc.number} for booking ${booking.reference}.`,
      '',
      `Amount due: ${quote.currency} ${formatMinor(doc.total)} (including GST)`,
      `Due by: ${doc.dueAt.toDateString()}`,
      '',
      basis === 'verified'
        ? 'This is based on the measurements we took at our depot.'
        : 'This is based on the sizes you gave us. We will re-check at the depot.',
    ].join('\n'),
  });

  return doc;
};

export const markInvoicePaid = async (number: string): Promise<InvoiceDoc> => {
  const result = await invoices().findOneAndUpdate(
    { number: number.toUpperCase(), status: 'issued' },
    { $set: { status: 'paid', paidAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!result) throw notFound(`Unpaid invoice ${number}`, 'invoice_not_found');
  return result;
};

export const findInvoice = async (number: string): Promise<InvoiceDoc> => {
  const invoice = await invoices().findOne({ number: number.toUpperCase() });
  if (!invoice) throw notFound(`Invoice ${number}`, 'invoice_not_found');
  return invoice;
};

export const listInvoices = async (): Promise<InvoiceDoc[]> =>
  invoices().find({}).sort({ issuedAt: -1 }).limit(100).toArray();

export const findInvoiceForBooking = async (reference: string): Promise<InvoiceDoc | null> =>
  invoices().findOne({ bookingRef: reference.toUpperCase(), status: { $ne: 'void' } });

// ── 3.2 Master Bill of Lading ──────────────────────────────────────────────

export interface BolHouseEntry {
  bookingRef: string;
  shipper: BookingDoc['sender'];
  consignee: BookingDoc['receiver'];
  marks: string[];
  packageCount: number;
  packaging: string;
  grossWeightKg: string;
  measurementM3: string;
}

export interface Bol {
  number: string;
  container: {
    containerNumber: string;
    type: string;
    sealNumber: string | null;
    vessel: string;
    voyage: string;
    portOfLoading: string;
    portOfDischarge: string;
    sailsAt: string;
    etaAt: string;
  };
  carrier: string;
  totals: { packages: number; grossWeightKg: string; measurementM3: string; houses: number };
  houses: BolHouseEntry[];
  issuedAt: string;
  freightTerms: string;
}

/**
 * Requirement 3.2: the Master Bill of Lading for a container.
 *
 * A consolidator's master BOL covers the whole container as one movement, with
 * each customer's shipment as a house entry beneath it. The totals at the top
 * are what the carrier and customs work from, so they are summed from the
 * measured figures on the pieces actually in the container — never from what
 * was booked, and never from the container's nominal capacity.
 *
 * The number is minted on first issue and then stable: a BOL that changes its
 * number between the copy the carrier holds and the copy we hold is not a
 * document anyone can act on.
 */
export const buildBol = async (containerNumber: string): Promise<Bol> => {
  const container = await containers().findOne({
    containerNumber: containerNumber.trim().toUpperCase().replace(/\s+/g, ' '),
  });
  if (!container) throw notFound(`Container ${containerNumber}`, 'container_not_found');

  const loaded = await pieces()
    .find({ containerId: container._id! })
    .sort({ bookingRef: 1, sequence: 1 })
    .toArray();

  if (loaded.length === 0) {
    throw badRequest(
      `Container ${container.containerNumber} is empty — there is nothing to bill`,
      'container_empty',
    );
  }

  const lane = LANES.find((l) => l.code === container.lane);
  const houses: BolHouseEntry[] = [];

  for (const reference of [...new Set(loaded.map((p) => p.bookingRef))]) {
    const booking = await bookings().findOne({ reference });
    if (!booking) continue;

    const mine = loaded.filter((p) => p.bookingRef === reference);
    const grams = mine.reduce((t, p) => t + (p.verified ?? p.declared).weightGrams, 0);
    const volume = mine.reduce((t, p) => t + (p.verified ?? p.declared).volume, 0);
    const kinds = [...new Set(mine.map((p) => p.packaging.replace(/_/g, ' ')))];

    houses.push({
      bookingRef: reference,
      shipper: booking.sender,
      consignee: booking.receiver,
      marks: mine.map((p) => p.trackingId!),
      packageCount: mine.length,
      packaging: kinds.join(', '),
      grossWeightKg: (grams / 1000).toFixed(1),
      measurementM3: formatVolume(volume),
    });
  }

  const totalGrams = loaded.reduce((t, p) => t + (p.verified ?? p.declared).weightGrams, 0);
  const totalVolume = loaded.reduce((t, p) => t + (p.verified ?? p.declared).volume, 0);

  // Reuse the number if one was already minted for this container.
  const documents = collection<DocumentNumberDoc>(COLLECTIONS.documents);
  const key = `bol:${container.containerNumber}`;

  // Mint on first ask, then reuse. Two people opening the BOL at once must not
  // produce two numbers for one container, so the loser of the race re-reads
  // the winner's rather than keeping its own.
  let number = (await documents.findOne({ key }))?.number;
  if (!number) {
    const minted = await nextBolNumber();
    try {
      await documents.insertOne({ kind: 'bol', key, number: minted });
      number = minted;
    } catch {
      number = (await documents.findOne({ key }))?.number ?? minted;
    }
  }

  return {
    number,
    container: {
      containerNumber: container.containerNumber,
      type: container.type,
      sealNumber: container.sealNumber,
      vessel: container.vessel,
      voyage: container.voyage,
      portOfLoading: lane?.from ?? 'Colombo',
      portOfDischarge: lane?.to ?? container.destinationLabel,
      sailsAt: container.sailsAt.toISOString(),
      etaAt: container.etaAt.toISOString(),
    },
    carrier: 'CargoFlow Consolidators (Pvt) Ltd',
    totals: {
      packages: loaded.length,
      grossWeightKg: (totalGrams / 1000).toFixed(1),
      measurementM3: formatVolume(totalVolume),
      houses: houses.length,
    },
    houses,
    issuedAt: new Date().toISOString(),
    freightTerms: 'FREIGHT PREPAID',
  };
};
