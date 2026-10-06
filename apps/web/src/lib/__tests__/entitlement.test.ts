import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueEntitlement, OFFLINE_GRACE_DAYS, privateKeyFrom, publicKeyPem, readEntitlement } from '../entitlement';
import { publicKeyFrom } from '../../../../desktop/src/main/license-token';

const { privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const input = { serial: 'VCDIT-AAAAA-BBBBB-CCCCC-DDDDD', plan: 'dit' as const, fingerprint: 'f'.repeat(64), email: 'a@b.c', paidThrough: null };

describe('entitlements', () => {
  it('signs a statement the public key reads back, good for the offline grace', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const { token, entitlement } = issueEntitlement(input, privateKey, now);
    expect(token.startsWith('vcdit1.')).toBe(true);
    expect(readEntitlement(token, publicKeyPem(privateKey))).toEqual(entitlement);
    expect(new Date(entitlement.validUntil).getTime() - now.getTime()).toBe(OFFLINE_GRACE_DAYS * 86_400_000);
  });

  it('refuses a token edited onto another computer', () => {
    const { token } = issueEntitlement(input, privateKey);
    const [prefix, payload, signature] = token.split('.');
    const edited = Buffer.from(Buffer.from(payload ?? '', 'base64url').toString().replace('f'.repeat(64), 'e'.repeat(64))).toString('base64url');
    expect(readEntitlement(`${prefix}.${edited}.${signature}`, publicKeyPem(privateKey))).toBeNull();
  });

  it('refuses a token signed by another key', () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    const { token } = issueEntitlement(input, other);
    expect(readEntitlement(token, publicKeyPem(privateKey))).toBeNull();
  });

  it('takes the key as PEM, PEM with escaped newlines, or base64 of the PEM', () => {
    const pub = publicKeyPem(privateKey);
    for (const form of [pem, pem.replace(/\n/g, '\\n'), Buffer.from(pem).toString('base64')]) {
      expect(publicKeyPem(privateKeyFrom(form))).toBe(pub);
    }
  });

  it('takes a passphrase instead of a key: the same passphrase is always the same key', () => {
    const passphrase = 'correct-horse-battery-staple-on-the-dit-cart-2026';
    const key = privateKeyFrom(passphrase);
    expect(publicKeyPem(privateKeyFrom(`  ${passphrase}\n`))).toBe(publicKeyPem(key));
    expect(publicKeyPem(privateKeyFrom(`${passphrase}!`))).not.toBe(publicKeyPem(key));
    // The desktop app reads the public half from /api/license/public-key and checks real tokens with it.
    const { token, entitlement } = issueEntitlement(input, key);
    expect(readEntitlement(token, publicKeyFrom(publicKeyPem(key))!)).toEqual(entitlement);
  });

  it('still takes a PEM key, raw or base64, and refuses a short passphrase', () => {
    expect(publicKeyPem(privateKeyFrom(pem))).toBe(publicKeyPem(privateKey));
    expect(publicKeyPem(privateKeyFrom(Buffer.from(pem).toString('base64')))).toBe(publicKeyPem(privateKey));
    expect(() => privateKeyFrom('too-short')).toThrow(/at least 32/);
  });
});
