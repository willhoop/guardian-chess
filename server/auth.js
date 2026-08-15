/**
 * Password hashing and session tokens.
 *
 * Uses scrypt from Node's own crypto module — no dependencies, and a memory-hard
 * function rather than a plain digest, so a stolen data file is expensive to
 * attack offline.
 *
 * Three rules this module exists to enforce:
 *   1. Plaintext passwords are never stored and never logged.
 *   2. Comparisons are timing-safe.
 *   3. Session tokens are stored hashed, so a leaked data file does not hand
 *      an attacker working logins.
 */

import {
  randomBytes, scrypt, timingSafeEqual, createHash,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Node's defaults need maxmem raised; these cost roughly 16MB per hash.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

export const USERNAME_RULES = {
  min: 3,
  max: 20,
  pattern: /^[A-Za-z0-9_-]+$/,
};
export const PASSWORD_MIN = 8;

/** Returns an error string, or null when the username is acceptable. */
export function validateUsername(username) {
  if (typeof username !== 'string') return 'Enter a username.';
  const name = username.trim();
  if (name.length < USERNAME_RULES.min) {
    return `Username must be at least ${USERNAME_RULES.min} characters.`;
  }
  if (name.length > USERNAME_RULES.max) {
    return `Username must be ${USERNAME_RULES.max} characters or fewer.`;
  }
  if (!USERNAME_RULES.pattern.test(name)) {
    return 'Username can use letters, numbers, hyphens and underscores only.';
  }
  return null;
}

/** Returns an error string, or null when the password is acceptable. */
export function validatePassword(password) {
  if (typeof password !== 'string') return 'Enter a password.';
  if (password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters.`;
  }
  if (password.length > 200) return 'That password is too long.';
  return null;
}

/** Hash a password for storage. Returns `salt:hash`, both hex. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

/**
 * Check a password against a stored hash. Always does the full comparison so
 * the answer does not leak through timing.
 */
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, keyHex] = stored.split(':');
  let expected;
  try {
    expected = Buffer.from(keyHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;

  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH, SCRYPT);
  return timingSafeEqual(actual, expected);
}

/** A fresh bearer token for a signed-in browser. */
export function makeSessionToken() {
  return randomBytes(32).toString('hex');
}

/** What we actually persist — never the token itself. */
export function hashSessionToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Identifiers for player records. Guests get one of these too. */
export function makePlayerId() {
  return randomBytes(16).toString('hex');
}
