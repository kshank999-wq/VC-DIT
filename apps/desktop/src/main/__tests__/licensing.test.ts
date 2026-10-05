import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// The site's own signer: the two sides of the token format are tested against each other.
import { issueEntitlement } from '../../../../web/src/lib/entitlement';
import { planFrom, publicKeyFrom, readToken } from '../license-token';
import { Licensing, type Stored } from '../licensing';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const FINGERPRINT = 'f'.repeat(64);
const token = (over: Partial<Parameters<typeof issueEntitlement>[0]> = {}, now = new Date()) =>
  issueEntitlement({ serial: 'VCDIT-AAAAA-BBBBB-CCCCC-DDDDD', plan: 'dit', fingerprint: FINGERPRINT, email: 'dit@example.com', paidThrough: '2027-01-01T00:00:00.000Z', ...over }, privateKey, now).token;

describe('the entitlement token', () => {
  it('reads what the site signs, with the key as PEM or base64', () => {
    for (const key of [publicKeyFrom(publicPem), publicKeyFrom(Buffer.from(publicPem).toString('base64'))]) {
      expect(readToken(token(), key!)).toMatchObject({ plan: 'dit', fingerprint: FINGERPRINT });
    }
    expect(publicKeyFrom('')).toBeNull();
    expect(publicKeyFrom('not a key')).toBeNull();
  });

  it('gives a plan only to this computer, until the date', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const entitlement = readToken(token({}, now), publicKey)!;
    expect(planFrom(entitlement, FINGERPRINT, now)).toBe('dit');
    expect(planFrom(entitlement, 'another computer', now)).toBeNull();
    expect(planFrom(entitlement, FINGERPRINT, new Date('2026-10-16T00:00:00Z'))).toBeNull();
  });

  it('refuses a token from another key or an edited one', () => {
    const other = generateKeyPairSync('ed25519').publicKey;
    expect(readToken(token(), other)).toBeNull();
    expect(readToken(token().replace(/\.[^.]+$/, '.AAAA'), publicKey)).toBeNull();
  });
});

/** A fake vc-dit.com: what the app's calls get back. */
const CODE = 'VCDIT-AAAAA-BBBBB-CCCCC-DDDDD';
const harness = (routes: Record<string, (body: Record<string, unknown>) => [number, Record<string, unknown>]>, stored: Partial<Stored> = {}) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let disk: Stored = { token: null, code: null, ...stored };
  let online = true;
  const licensing = new Licensing({
    config: { siteUrl: 'https://site.test', publicKey },
    fetch: (async (url: string, init?: RequestInit) => {
      if (!online) throw new TypeError('fetch failed');
      const path = url.replace(/^https:\/\/[^/]+/, '');
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ path: `${init?.method ?? 'GET'} ${path}`, body });
      const route = routes[path];
      const [status, json] = route ? route(body) : [404, {}];
      return new Response(JSON.stringify(json), { status });
    }) as typeof fetch,
    load: async () => disk,
    save: async (next) => {
      disk = next;
    },
    fingerprint: async () => FINGERPRINT,
    device: () => ({ deviceName: 'DIT Cart', platform: 'macos', appVersion: '0.1.0' }),
  });
  return { licensing, calls, disk: () => disk, offline: () => (online = false) };
};

describe('licensing with an authorization code', () => {
  it('starts not activated, and no transfer may start', async () => {
    const h = harness({});
    expect(await h.licensing.start()).toMatchObject({ plan: 'none', state: 'not-activated' });
    expect(h.licensing.canStartTransfers()).toBe(false);
  });

  it('activates with the code, keeps the code and the entitlement, and says who it is licensed to', async () => {
    const h = harness({ '/api/licenses/activate': () => [200, { token: token() }] });
    await h.licensing.start();
    const access = await h.licensing.activate(' aaaaa-bbbbb-ccccc-ddddd ');
    expect(access).toMatchObject({ plan: 'dit', state: 'licensed', email: 'dit@example.com', serial: CODE, message: null });
    expect(h.calls[0]).toMatchObject({ path: 'POST /api/licenses/activate', body: { code: 'aaaaa-bbbbb-ccccc-ddddd', fingerprint: FINGERPRINT, platform: 'macos' } });
    // The canonical code from the signed answer is what is kept, not what was typed.
    expect(h.disk().code).toBe(CODE);
    expect(h.licensing.canStartTransfers()).toBe(true);
  });

  it('shows the site’s refusal as it is, and keeps nothing', async () => {
    const h = harness({ '/api/licenses/activate': () => [409, { error: 'This subscription is already on 2 of 2 computers.', reason: 'no_slots' }] });
    await h.licensing.start();
    expect(await h.licensing.activate(CODE)).toMatchObject({ plan: 'none', message: 'This subscription is already on 2 of 2 computers.' });
    expect(h.disk()).toMatchObject({ token: null, code: null });
    expect(await h.licensing.activate('  ')).toMatchObject({ message: expect.stringMatching(/authorization code/) });
  });

  it('checks in with the kept code, and loses the seat when the site says so', async () => {
    let answer: [number, Record<string, unknown>] = [200, { token: token() }];
    const h = harness({ '/api/licenses/status': () => answer }, { token: token(), code: CODE });
    await h.licensing.start();
    expect((await h.licensing.refresh()).state).toBe('licensed');
    expect(h.calls[0]?.body).toMatchObject({ code: CODE, fingerprint: FINGERPRINT });

    answer = [409, { error: 'This computer was removed from your subscription on the account page.', reason: 'device_removed' }];
    expect(await h.licensing.refresh()).toMatchObject({ plan: 'none', state: 'not-activated', message: expect.stringMatching(/removed/) });
    expect(h.disk().code).toBe(CODE);
  });

  it('forgets a code the site no longer knows', async () => {
    const h = harness({ '/api/licenses/status': () => [409, { error: 'That authorization code was not recognised.', reason: 'unknown_code' }] }, { token: token(), code: CODE });
    await h.licensing.start();
    await h.licensing.refresh();
    expect(h.disk()).toEqual({ token: null, code: null });
  });

  it('works offline on the last entitlement, then says it has expired', async () => {
    const issued = new Date('2026-10-01T00:00:00Z');
    let now = new Date('2026-10-05T00:00:00Z');
    const h = harness({}, { token: token({}, issued), code: CODE });
    const licensing = new Licensing({ ...(h.licensing as unknown as { deps: ConstructorParameters<typeof Licensing>[0] }).deps, now: () => now });
    h.offline();
    expect((await licensing.start()).state).toBe('licensed');
    expect((await licensing.refresh()).state).toBe('licensed');
    now = new Date('2026-10-20T00:00:00Z');
    expect(licensing.access()).toMatchObject({ plan: 'none', state: 'expired-offline' });
  });

  it('deactivates: frees its seat by code and forgets it here', async () => {
    const h = harness({ '/api/licenses/devices': () => [200, { deactivated: true }] }, { token: token(), code: CODE });
    await h.licensing.start();
    expect(await h.licensing.deactivate()).toMatchObject({ plan: 'none', state: 'not-activated' });
    expect(h.calls[0]).toMatchObject({ path: 'DELETE /api/licenses/devices', body: { code: CODE, fingerprint: FINGERPRINT } });
    expect(h.disk()).toEqual({ token: null, code: null });
  });

  it('a developer build without the key is unlocked and says so', async () => {
    const dev = new Licensing({ ...(harness({}).licensing as unknown as { deps: ConstructorParameters<typeof Licensing>[0] }).deps, config: { siteUrl: 'https://site.test', publicKey: null } });
    expect(await dev.start()).toMatchObject({ plan: 'dit', state: 'not-configured' });
    expect(dev.canStartTransfers()).toBe(true);
  });
});
