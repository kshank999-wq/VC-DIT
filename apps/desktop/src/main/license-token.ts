import { createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Reading the entitlement vc-dit.com signs (apps/web/src/lib/entitlement.ts):
 * `vcdit1.<payload>.<signature>`, Ed25519, the signature over `vcdit1.<payload>`.
 * The public key is built into the app, so the file it keeps cannot be edited
 * onto another computer or a later date.
 */

export type Plan = 'dit';

export interface Entitlement {
  serial: string;
  plan: Plan;
  fingerprint: string;
  email: string;
  paidThrough: string | null;
  issuedAt: string;
  validUntil: string;
}

/** The key from its build variable: PEM, or the PEM base64-encoded on one line. */
export const publicKeyFrom = (value: string): KeyObject | null => {
  const text = value.trim();
  if (!text) return null;
  try {
    return createPublicKey(text.includes('BEGIN') ? text.replace(/\\n/g, '\n') : Buffer.from(text, 'base64').toString('utf8'));
  } catch {
    return null;
  }
};

export const readToken = (token: string, key: KeyObject): Entitlement | null => {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'vcdit1') return null;
  try {
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2] ?? '', 'base64url'))) return null;
    const value = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Entitlement;
    return value.plan === 'dit' ? value : null;
  } catch {
    return null;
  }
};

/** Whether this computer is licensed now, from the last entitlement it was given. */
export const planFrom = (entitlement: Entitlement | null, fingerprint: string, now: Date): Plan | null => {
  if (!entitlement || entitlement.fingerprint !== fingerprint) return null;
  return new Date(entitlement.validUntil).getTime() > now.getTime() ? entitlement.plan : null;
};
