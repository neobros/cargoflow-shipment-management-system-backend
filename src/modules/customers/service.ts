import { createHash, randomBytes } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import { COLLECTIONS, collection } from '../../db/mongo.js';
import { AppError, badRequest, conflict, notFound } from '../../shared/errors.js';
import { formatMinor } from '../../shared/units.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { findInvoiceForBooking, listInvoices } from '../documents/service.js';
import { LANES } from '../pricing/rate-cards.js';
import { nextCustomerReference } from '../shipments/sequences.js';
import type { AdjustmentDoc, BookingDoc, PieceDoc } from '../shipments/types.js';
import { PIECE_STATUS_LABELS } from '../shipments/types.js';
import {
  CUSTOMER_SESSION_TTL_DAYS,
  toCurrentCustomer,
  type CurrentCustomer,
  type CustomerDoc,
  type CustomerSessionDoc,
  type RegisterInput,
  type SignInInput,
} from './types.js';

const customers = () => collection<CustomerDoc>(COLLECTIONS.customers);
const sessions = () => collection<CustomerSessionDoc>(COLLECTIONS.customerSessions);
const bookings = () => collection<BookingDoc>(COLLECTIONS.bookings);
const pieces = () => collection<PieceDoc>(COLLECTIONS.pieces);
const adjustments = () => collection<AdjustmentDoc>(COLLECTIONS.adjustments);

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

const normaliseMobile = (mobile: string) => mobile.replace(/[ ()-]/g, '');

export interface SignedIn {
  token: string;
  expiresAt: Date;
  customer: CustomerDoc;
}

const openSession = async (
  customer: CustomerDoc,
  context: { userAgent?: string; ip?: string },
): Promise<SignedIn> => {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CUSTOMER_SESSION_TTL_DAYS * 86_400_000);

  await sessions().insertOne({
    tokenHash: digest(token),
    customerId: customer._id!,
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
    userAgent: context.userAgent ?? null,
    ip: context.ip ?? null,
  });

  await customers().updateOne({ _id: customer._id }, { $set: { lastLoginAt: now } });

  return { token, expiresAt, customer };
};

/**
 * Create an account.
 *
 * Both the email and the mobile are unique, because both identify the person:
 * the email signs them in, the mobile receives the price-change SMS. Two
 * accounts sharing a mobile would mean a message about one person's shipment
 * arriving on a phone that can sign in as somebody else.
 */
export const register = async (
  input: RegisterInput,
  context: { userAgent?: string; ip?: string },
): Promise<SignedIn> => {
  const mobile = normaliseMobile(input.mobile);

  const clash = await customers().findOne({ $or: [{ email: input.email }, { mobile }] });
  if (clash) {
    // Say which one, because "an account already exists" leaves someone
    // guessing whether to try a different email or a different phone.
    throw conflict(
      clash.email === input.email
        ? 'An account already uses that email address. Sign in instead.'
        : 'An account already uses that mobile number. Sign in instead.',
      'account_exists',
    );
  }

  const now = new Date();
  const doc: CustomerDoc = {
    reference: await nextCustomerReference(),
    name: input.name,
    email: input.email,
    mobile,
    passwordHash: await hashPassword(input.password),
    lastSender: null,
    // No provider is wired up to send a verification link, so recording the
    // claim honestly as unverified beats pretending it was confirmed.
    emailVerifiedAt: null,
    lastLoginAt: null,
    createdAt: now,
  };

  try {
    const result = await customers().insertOne(doc);
    doc._id = result.insertedId;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw conflict('An account already exists with those details', 'account_exists');
    }
    throw error;
  }

  return openSession(doc, context);
};

/**
 * Sign in.
 *
 * A missing account and a wrong password give the same message and both do the
 * hashing work, so the endpoint cannot be used to discover which email
 * addresses have accounts by watching either the wording or the timing.
 */
const DUMMY_HASH = 'de1e7e5f00000000000000000000000000000000000000000000000000000000:' + '0'.repeat(128);

export const signIn = async (
  input: SignInInput,
  context: { userAgent?: string; ip?: string },
): Promise<SignedIn> => {
  const customer = await customers().findOne({ email: input.email });
  const ok = await verifyPassword(input.password, customer?.passwordHash ?? DUMMY_HASH);

  if (!customer || !ok) {
    throw new AppError('That email and password do not match', 'invalid_credentials', 401);
  }

  return openSession(customer, context);
};

/** Resolve a cookie to a customer, sliding the expiry as they use the site. */
export const resolveCustomerSession = async (
  token: string | undefined,
): Promise<CustomerDoc | null> => {
  if (!token) return null;

  const session = await sessions().findOne({ tokenHash: digest(token) });
  if (!session) return null;

  const now = new Date();
  if (session.expiresAt <= now) {
    await sessions().deleteOne({ _id: session._id });
    return null;
  }

  const customer = await customers().findOne({ _id: session.customerId });
  if (!customer) return null;

  await sessions().updateOne(
    { _id: session._id },
    {
      $set: {
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + CUSTOMER_SESSION_TTL_DAYS * 86_400_000),
      },
    },
  );

  return customer;
};

export const signOut = async (token: string | undefined): Promise<void> => {
  if (token) await sessions().deleteOne({ tokenHash: digest(token) });
};

export const changePassword = async (
  customer: CustomerDoc,
  current: string,
  next: string,
): Promise<void> => {
  if (!(await verifyPassword(current, customer.passwordHash))) {
    throw badRequest('That is not your current password', 'wrong_password');
  }
  if (next.length < 10) {
    throw badRequest('Use at least 10 characters', 'password_too_short');
  }

  await customers().updateOne(
    { _id: customer._id },
    { $set: { passwordHash: await hashPassword(next) } },
  );

  // Every other device is signed out. A password change is usually a response
  // to someone else having had access.
  await sessions().deleteMany({ customerId: customer._id! });
};

/** Remember the last address used, so the next booking pre-fills. */
export const rememberSender = async (
  customerId: ObjectId,
  sender: CustomerDoc['lastSender'],
): Promise<void> => {
  await customers().updateOne({ _id: customerId }, { $set: { lastSender: sender } });
};

// ── What a signed-in customer can see ──────────────────────────────────────

export interface CustomerShipment {
  reference: string;
  status: string;
  statusLabel: string;
  route: string;
  service: string;
  pieceCount: number;
  bookedTotal: string;
  currentTotal: string;
  awaitingApproval: boolean;
  invoiceNumber: string | null;
  bookedAt: string;
}

/**
 * Their shipments, and only theirs.
 *
 * Scoped by the session's customer id rather than by anything in the request,
 * so there is no reference a curious person could pass to read somebody else's
 * shipment.
 */
export const shipmentsFor = async (customerId: ObjectId): Promise<CustomerShipment[]> => {
  const mine = await bookings()
    .find({ customerId })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();

  const out: CustomerShipment[] = [];

  for (const booking of mine) {
    const lane = LANES.find((l) => l.code === booking.lane);
    const all = await pieces().find({ bookingId: booking._id! }).toArray();
    const open = await adjustments().findOne({
      bookingId: booking._id!,
      state: 'awaiting_approval',
    });
    const invoice = await findInvoiceForBooking(booking.reference);

    out.push({
      reference: booking.reference,
      status: booking.status,
      statusLabel: PIECE_STATUS_LABELS[booking.status] ?? booking.status,
      route: lane ? `${lane.from} → ${lane.to}` : booking.lane,
      service: booking.service === 'sea_lcl' ? 'Sea' : 'Air',
      pieceCount: all.length,
      bookedTotal: formatMinor(booking.bookedQuote.total.amount),
      currentTotal: formatMinor(
        (booking.verifiedQuote ?? booking.bookedQuote).total.amount,
      ),
      awaitingApproval: Boolean(open),
      invoiceNumber: invoice?.number ?? null,
      bookedAt: booking.createdAt.toISOString(),
    });
  }

  return out;
};

/** Their invoices, scoped the same way. */
export const invoicesFor = async (customerReference: string) => {
  const all = await listInvoices();
  return all.filter((invoice) => invoice.customerRef === customerReference);
};

export const invoiceFor = async (customerReference: string, number: string) => {
  const invoice = (await invoicesFor(customerReference)).find(
    (candidate) => candidate.number === number.toUpperCase(),
  );
  // Not "forbidden": someone else's invoice number should be indistinguishable
  // from one that does not exist.
  if (!invoice) throw notFound(`Invoice ${number}`, 'invoice_not_found');
  return invoice;
};

export const currentCustomer = (doc: CustomerDoc): CurrentCustomer => toCurrentCustomer(doc);
