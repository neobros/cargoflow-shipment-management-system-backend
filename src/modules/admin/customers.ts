import { COLLECTIONS, collection } from '../../db/mongo.js';
import { notFound } from '../../shared/errors.js';
import { formatMinor } from '../../shared/units.js';
import type { CustomerDoc } from '../customers/types.js';
import type { InvoiceDoc } from '../documents/service.js';
import { LANES } from '../pricing/rate-cards.js';
import type { BookingDoc } from '../shipments/types.js';
import { PIECE_STATUS_LABELS } from '../shipments/types.js';

const customers = () => collection<CustomerDoc>(COLLECTIONS.customers);
const bookings = () => collection<BookingDoc>(COLLECTIONS.bookings);
const invoices = () => collection<InvoiceDoc>(COLLECTIONS.invoices);

/**
 * The customer directory.
 *
 * What a clerk on the phone needs: who they are, how to reach them, what they
 * have sent, and whether they owe anything. Deliberately not a CRM — there is
 * no notes field, no tags, no lifecycle stage, because none of that is in the
 * brief and a half-built CRM is worse than none.
 */

export interface CustomerSummary {
  reference: string;
  name: string;
  email: string;
  mobile: string;
  shipments: number;
  /** Anything not yet delivered — what a "where is my box" call is about. */
  inFlight: number;
  billedTotal: string;
  outstandingTotal: string;
  overdueCount: number;
  lastBookedAt: string | null;
  joinedAt: string;
}

export const listCustomers = async (search?: string): Promise<{ customers: CustomerSummary[] }> => {
  // One case-insensitive match across the three things a clerk is told on the
  // phone: a name, an email, or the number they are calling from.
  const filter = search
    ? {
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { mobile: { $regex: search.replace(/[^\d+]/g, ''), $options: 'i' } },
          { reference: { $regex: search, $options: 'i' } },
        ],
      }
    : {};

  const found = await customers().find(filter).sort({ createdAt: -1 }).limit(100).toArray();
  const now = new Date();
  const out: CustomerSummary[] = [];

  for (const customer of found) {
    const mine = await bookings().find({ customerId: customer._id! }).toArray();
    const bills = await invoices()
      .find({ customerRef: customer.reference, status: { $ne: 'void' } })
      .toArray();

    const unpaid = bills.filter((invoice) => invoice.status === 'issued');

    out.push({
      reference: customer.reference,
      name: customer.name,
      email: customer.email,
      mobile: customer.mobile,
      shipments: mine.length,
      inFlight: mine.filter((booking) => booking.status !== 'delivered').length,
      billedTotal: formatMinor(bills.reduce((total, invoice) => total + invoice.total, 0)),
      outstandingTotal: formatMinor(unpaid.reduce((total, invoice) => total + invoice.total, 0)),
      overdueCount: unpaid.filter((invoice) => invoice.dueAt < now).length,
      lastBookedAt:
        mine.map((b) => b.createdAt).sort((a, b) => b.getTime() - a.getTime())[0]?.toISOString() ?? null,
      joinedAt: customer.createdAt.toISOString(),
    });
  }

  return { customers: out };
};

export const getCustomer = async (reference: string) => {
  const customer = await customers().findOne({ reference: reference.toUpperCase() });
  if (!customer) throw notFound(`Customer ${reference}`, 'customer_not_found');

  const mine = await bookings().find({ customerId: customer._id! }).sort({ createdAt: -1 }).toArray();
  const bills = await invoices()
    .find({ customerRef: customer.reference, status: { $ne: 'void' } })
    .sort({ issuedAt: -1 })
    .toArray();

  return {
    customer: {
      reference: customer.reference,
      name: customer.name,
      email: customer.email,
      mobile: customer.mobile,
      joinedAt: customer.createdAt.toISOString(),
      lastLoginAt: customer.lastLoginAt?.toISOString() ?? null,
      emailVerified: customer.emailVerifiedAt !== null,
      lastSender: customer.lastSender,
    },
    shipments: mine.map((booking) => {
      const lane = LANES.find((l) => l.code === booking.lane);
      return {
        reference: booking.reference,
        route: lane ? `${lane.from} → ${lane.to}` : booking.lane,
        status: booking.status,
        statusLabel: PIECE_STATUS_LABELS[booking.status] ?? booking.status,
        total: formatMinor((booking.verifiedQuote ?? booking.bookedQuote).total.amount),
        bookedAt: booking.createdAt.toISOString(),
      };
    }),
    invoices: bills.map((invoice) => ({
      number: invoice.number,
      bookingRef: invoice.bookingRef,
      total: formatMinor(invoice.total),
      status: invoice.status,
      dueAt: invoice.dueAt.toISOString(),
      overdue: invoice.status === 'issued' && invoice.dueAt < new Date(),
    })),
  };
};
