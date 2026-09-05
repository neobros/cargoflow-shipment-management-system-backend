import type { ObjectId } from 'mongodb';
import { z } from 'zod';

/**
 * A customer account.
 *
 * Deliberately separate from StaffDoc and on its own cookie. A customer and a
 * depot supervisor are not the same kind of principal, and one table with a
 * `type` column is how a permission check eventually gets written that treats
 * them as interchangeable. Two collections, two cookies, two guards — the
 * mistake becomes impossible rather than merely unlikely.
 */
export interface CustomerDoc {
  _id?: ObjectId;
  /** CF-00001 — what staff quote on the phone. */
  reference: string;
  name: string;
  email: string;
  mobile: string;
  /** scrypt: salt:derivedKey, both hex. */
  passwordHash: string;
  /** Set once the address is used on a booking, so the next one pre-fills. */
  lastSender: Party | null;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

interface Party {
  name: string;
  mobile: string;
  email?: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postcode: string;
  country: string;
  idNumber?: string;
}

export interface CustomerSessionDoc {
  _id?: ObjectId;
  /** SHA-256 of the cookie value — a database leak must not hand over sessions. */
  tokenHash: string;
  customerId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  userAgent: string | null;
  ip: string | null;
}

/** Distinct from the staff cookie, so the two can never be confused. */
export const CUSTOMER_SESSION_COOKIE = 'cf_customer_session';

/**
 * Thirty days. A customer checks on a shipment once a week at most, and being
 * signed out between checks is the thing that makes people give up and ring
 * the office instead.
 */
export const CUSTOMER_SESSION_TTL_DAYS = 30;

export const RegisterInput = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  mobile: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 ()-]{6,19}$/, 'Enter a mobile number we can reach, with country code'),
  // Length beats composition rules: "Password1!" is weaker than four ordinary
  // words, and complexity requirements mostly produce written-down passwords.
  password: z.string().min(10).max(200),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const SignInInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});
export type SignInInput = z.infer<typeof SignInInput>;

/** What the browser is told about who it is. Never the hash, never the id. */
export interface CurrentCustomer {
  reference: string;
  name: string;
  email: string;
  mobile: string;
  lastSender: Party | null;
}

export const toCurrentCustomer = (doc: CustomerDoc): CurrentCustomer => ({
  reference: doc.reference,
  name: doc.name,
  email: doc.email,
  mobile: doc.mobile,
  lastSender: doc.lastSender,
});
