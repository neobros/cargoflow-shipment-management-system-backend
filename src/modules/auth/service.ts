import { createHash, randomBytes } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import { COLLECTIONS, collection } from '../../db/mongo.js';
import { AppError } from '../../shared/errors.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { SESSION_TTL_HOURS, type Role, type SessionDoc, type StaffDoc } from './types.js';

const staff = () => collection<StaffDoc>(COLLECTIONS.staff);
const sessions = () => collection<SessionDoc>(COLLECTIONS.sessions);

/** The cookie carries the token; the database only ever sees its digest. */
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface LoginResult {
  token: string;
  expiresAt: Date;
  staff: StaffDoc;
}

export const login = async (
  email: string,
  password: string,
  context: { userAgent?: string | null; ip?: string | null } = {},
): Promise<LoginResult> => {
  const account = await staff().findOne({ email: email.trim().toLowerCase() });

  // One message and one timing profile for "no such account", "wrong password"
  // and "account disabled". A login form is not a directory of who works here.
  const ok = account?.active === true && (await verifyPassword(password, account.passwordHash));
  if (!account || !ok) {
    // Burn comparable time on a miss so the absence of an account is not
    // measurably faster than a wrong password.
    if (!account) await verifyPassword(password, `${'0'.repeat(32)}:${'0'.repeat(128)}`);
    throw new AppError('That email and password do not match', 'invalid_credentials', 401);
  }

  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * 3_600_000);

  await sessions().insertOne({
    tokenHash: digest(token),
    staffId: account._id!,
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
    userAgent: context.userAgent ?? null,
    ip: context.ip ?? null,
  });

  await staff().updateOne({ _id: account._id }, { $set: { lastLoginAt: now } });

  return { token, expiresAt, staff: account };
};

/**
 * Resolve a cookie to a staff member, sliding the expiry as they work.
 * Returns null rather than throwing — plenty of callers just want to know
 * whether anyone is signed in.
 */
export const resolveSession = async (token: string | undefined): Promise<StaffDoc | null> => {
  if (!token) return null;

  const session = await sessions().findOne({ tokenHash: digest(token) });
  if (!session) return null;

  const now = new Date();
  if (session.expiresAt <= now) {
    await sessions().deleteOne({ _id: session._id });
    return null;
  }

  const account = await staff().findOne({ _id: session.staffId });
  if (!account?.active) return null;

  // Sliding window: an operator mid-shift should not be logged out for being
  // busy, but a forgotten session still dies overnight.
  await sessions().updateOne(
    { _id: session._id },
    { $set: { lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_HOURS * 3_600_000) } },
  );

  return account;
};

export const logout = async (token: string | undefined): Promise<void> => {
  if (!token) return;
  await sessions().deleteOne({ tokenHash: digest(token) });
};

/** Revoke every session for one person — a lost depot handheld, say. */
export const revokeAllSessions = async (staffId: ObjectId): Promise<number> => {
  const result = await sessions().deleteMany({ staffId });
  return result.deletedCount;
};

export const createStaff = async (input: {
  email: string;
  name: string;
  role: Role;
  password: string;
  depotId?: string | null;
}): Promise<void> => {
  await staff().insertOne({
    email: input.email.trim().toLowerCase(),
    name: input.name,
    role: input.role,
    passwordHash: await hashPassword(input.password),
    depotId: input.depotId ?? null,
    active: true,
    lastLoginAt: null,
    createdAt: new Date(),
  });
};

export const countStaff = async (): Promise<number> => staff().countDocuments();
