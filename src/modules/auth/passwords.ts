import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

/**
 * scrypt from Node's own crypto — no native build step, no dependency to keep
 * patched, and memory-hard by design so a leaked hash table is expensive to
 * grind through.
 */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
};

/**
 * Constant-time comparison. A wrong password and a malformed stored hash both
 * return false rather than throwing, so the login route cannot be probed for
 * which accounts exist by watching for a 500.
 */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;

  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    if (expected.length !== KEY_LENGTH) return false;

    const derived = await scrypt(password, salt, KEY_LENGTH);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
};
