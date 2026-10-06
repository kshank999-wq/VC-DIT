import { createPrivateKey, createPublicKey, scryptSync, sign, verify, type KeyObject } from 'node:crypto';
import type { Plan } from './env';

/**
 * What the desktop app is allowed to do, signed by this site.
 *
 * The app keeps working offline, so it cannot ask the site every time it
 * saves. Instead the site hands it a short-lived statement — this license, this
 * plan, this computer, good until a date — signed with an Ed25519 key only the
 * site holds. The app checks the signature with the public key built into it,
 * so the file it keeps cannot be edited into a better plan or a later date. It
 * fetches a fresh one whenever it is online (at start and every few hours);
 * offline, the last one lasts its grace period.
 *
 * Format: `vcdit1.<payload>.<signature>`, both base64url, the signature over
 * `vcdit1.<payload>`. apps/desktop/src/main/license-token.ts reads the same thing.
 */

export const TOKEN_PREFIX = 'vcdit1';
/** How long the app works without reaching the site. */
export const OFFLINE_GRACE_DAYS = 14;

export interface Entitlement {
  serial: string;
  plan: Plan;
  fingerprint: string;
  email: string;
  /** End of the period paid for, ISO; shown in the app. */
  paidThrough: string | null;
  issuedAt: string;
  validUntil: string;
}

const base64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

/** The fixed DER prefix of an Ed25519 PKCS#8 private key; the 32-byte seed follows it. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export const MIN_PASSPHRASE_LENGTH = 32;

/**
 * The key from its environment variable, in any of three forms:
 * - a PEM private key;
 * - the PEM base64-encoded on one line;
 * - a long random passphrase (32+ characters, from a password manager), from
 *   which the key is derived. This is the easy one: nothing to generate in a
 *   terminal, and the desktop build fetches the matching public key from
 *   /api/license/public-key, so there is nothing else to copy anywhere.
 *   scrypt makes the derivation slow on purpose, so the key is no easier to
 *   guess than the passphrase. Changing the passphrase is changing the key.
 */
export const privateKeyFrom = (value: string): KeyObject => {
  const text = value.trim();
  if (text.includes('BEGIN')) return createPrivateKey(text.replace(/\\n/g, '\n'));
  const decoded = Buffer.from(text, 'base64').toString('utf8');
  if (decoded.includes('BEGIN')) return createPrivateKey(decoded);
  if (text.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`LICENSE_SIGNING_PRIVATE_KEY is too short: use a key, or a random passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const seed = scryptSync(text, 'vcdit-license-key-v1', 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
};

export const publicKeyPem = (privateKey: KeyObject): string =>
  createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();

export const issueEntitlement = (
  input: Omit<Entitlement, 'issuedAt' | 'validUntil'>,
  privateKey: KeyObject,
  now = new Date(),
): { token: string; entitlement: Entitlement } => {
  const entitlement: Entitlement = {
    ...input,
    issuedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + OFFLINE_GRACE_DAYS * 86_400_000).toISOString(),
  };
  const body = `${TOKEN_PREFIX}.${base64url(JSON.stringify(entitlement))}`;
  const signature = sign(null, Buffer.from(body), privateKey);
  return { token: `${body}.${base64url(signature)}`, entitlement };
};

/** For tests and support: the entitlement a token carries, if its signature holds. */
export const readEntitlement = (token: string, publicKey: KeyObject | string): Entitlement | null => {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2] ?? '', 'base64url'));
  if (!ok) return null;
  try {
    return JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Entitlement;
  } catch {
    return null;
  }
};
