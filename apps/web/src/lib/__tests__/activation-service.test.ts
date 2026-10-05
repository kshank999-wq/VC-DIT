import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { activateDevice, checkDevice, codeMayDownload, deactivateByCode, deactivateDevice, listDevices } from '../activation-service';
import { publicKeyPem, readEntitlement } from '../entitlement';
import { fakeSupabase, type Tables } from './fake-supabase';

const { privateKey } = generateKeyPairSync('ed25519');
const CODE = 'VCDIT-AAAAA-BBBBB-CCCCC-DDDDD';
const device = (fingerprint: string) => ({ fingerprint: fingerprint.repeat(16), deviceName: `Cart ${fingerprint}`, platform: 'macos' as const, appVersion: '0.1.0' });
const license = (over: Record<string, unknown> = {}) => ({
  id: 'L1',
  user_id: 'u1',
  serial: CODE,
  plan: 'dit',
  status: 'active',
  max_activations: 2,
  paid_through: '2027-01-01T00:00:00.000Z',
  ...over,
});
const seed = (licenses: Record<string, unknown>[]): Tables => ({
  dit_licenses: licenses as Tables[string],
  dit_device_activations: [],
  profiles: [{ id: 'u1', email: 'dit@example.com' }],
});

describe('activating computers with an authorization code', () => {
  it('activates, and the signed entitlement names the code, this computer and the owner', async () => {
    const db = fakeSupabase(seed([license()]));
    const result = await activateDevice(CODE, device('a'), db.client, privateKey);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readEntitlement(result.token, publicKeyPem(privateKey))).toMatchObject({
      plan: 'dit',
      serial: CODE,
      fingerprint: 'a'.repeat(16),
      email: 'dit@example.com',
    });
  });

  it('takes the code however it is typed', async () => {
    const db = fakeSupabase(seed([license()]));
    expect((await activateDevice(' aaaaa bbbbb ccccc ddddd ', device('a'), db.client, privateKey)).ok).toBe(true);
  });

  it('two computers, then a clear refusal; a reinstall is the same seat', async () => {
    const db = fakeSupabase(seed([license()]));
    expect((await activateDevice(CODE, device('a'), db.client, privateKey)).ok).toBe(true);
    expect((await activateDevice(CODE, device('a'), db.client, privateKey)).ok).toBe(true);
    expect((await activateDevice(CODE, device('b'), db.client, privateKey)).ok).toBe(true);
    expect(await activateDevice(CODE, device('c'), db.client, privateKey)).toMatchObject({ ok: false, reason: 'no_slots' });
    expect(db.tables['dit_device_activations']).toHaveLength(2);
  });

  it('refuses an unknown or malformed code, and an ended subscription', async () => {
    const db = fakeSupabase(seed([license()]));
    expect(await activateDevice('VCDIT-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', device('a'), db.client, privateKey)).toMatchObject({ ok: false, reason: 'unknown_code' });
    expect(await activateDevice('hello', device('a'), db.client, privateKey)).toMatchObject({ ok: false, reason: 'unknown_code' });
    (db.tables['dit_licenses'] ?? [])[0]!['status'] = 'expired';
    expect(await activateDevice(CODE, device('a'), db.client, privateKey)).toMatchObject({ ok: false, reason: 'license_inactive' });
  });

  it('checks in while the license holds, and stops when the seat is freed or the subscription ends', async () => {
    const db = fakeSupabase(seed([license()]));
    await activateDevice(CODE, device('a'), db.client, privateKey);
    expect((await checkDevice(CODE, device('a'), db.client, privateKey)).ok).toBe(true);
    expect(await checkDevice(CODE, device('z'), db.client, privateKey)).toMatchObject({ ok: false, reason: 'not_activated' });

    const [seat] = await listDevices('u1', db.client);
    expect(seat).toMatchObject({ name: 'Cart a', platform: 'macos', deactivatedAt: null, serial: CODE });
    expect(await deactivateDevice('u1', seat?.id ?? '', db.client)).toEqual({ ok: true, error: null });
    expect(await checkDevice(CODE, device('a'), db.client, privateKey)).toMatchObject({ ok: false, reason: 'device_removed' });

    await activateDevice(CODE, device('a'), db.client, privateKey);
    (db.tables['dit_licenses'] ?? [])[0]!['status'] = 'expired';
    expect(await checkDevice(CODE, device('a'), db.client, privateKey)).toMatchObject({ ok: false, reason: 'license_inactive' });
  });

  it('frees seats only for their owner, or for the computer holding the code', async () => {
    const db = fakeSupabase(seed([license()]));
    await activateDevice(CODE, device('a'), db.client, privateKey);
    const [seat] = await listDevices('u1', db.client);
    expect((await deactivateDevice('intruder', seat?.id ?? '', db.client)).ok).toBe(false);
    expect((await deactivateByCode('VCDIT-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', 'a'.repeat(16), db.client)).ok).toBe(false);
    expect((await deactivateByCode(CODE, 'a'.repeat(16), db.client)).ok).toBe(true);
    expect((await deactivateByCode(CODE, 'a'.repeat(16), db.client)).ok).toBe(false);
  });

  it('lets an active code download, and nothing else', async () => {
    const db = fakeSupabase(seed([license()]));
    expect(await codeMayDownload(CODE, db.client)).toBe(true);
    expect(await codeMayDownload('VCDIT-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', db.client)).toBe(false);
    (db.tables['dit_licenses'] ?? [])[0]!['status'] = 'revoked';
    expect(await codeMayDownload(CODE, db.client)).toBe(false);
  });
});
