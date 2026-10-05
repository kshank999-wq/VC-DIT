import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
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

/** The key from its environment variable: PEM, or the PEM base64-encoded (one line, easier to paste). */
export const privateKeyFrom = (value: string): KeyObject => {
  const pem = value.includes('BEGIN') ? value.replace(/\\n/g, '\n') : Buffer.from(value, 'base64').toString('utf8');
  return createPrivateKey(pem);
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
