import { describe, expect, it } from 'vitest';
import { isNewer, releasePlatform, Updater, type Kept } from '../updates';
import type { UpdateState } from '../../shared/updates';

const DAY = 24 * 60 * 60 * 1000;

type Release = { platform: string; version: string; release_notes?: string; minimum_os_version?: string };
const respond = (list: Release[]) => new Response(JSON.stringify({ releases: list }), { status: 200, headers: { 'content-type': 'application/json' } });
const releases = (list: Release[]) => (async () => respond(list)) as unknown as typeof fetch;

const updater = (options: { current?: string; platform?: 'windows' | 'macos' | null; fetch: typeof fetch; kept?: Kept; clock?: { now: number } }) => {
  const clock = options.clock ?? { now: Date.parse('2026-10-16T09:00:00Z') };
  const saved: Kept[] = [];
  const told: UpdateState[] = [];
  const instance = new Updater({
    site: 'https://vc-dit.com',
    current: options.current ?? '0.1.0',
    platform: options.platform === undefined ? 'windows' : options.platform,
    fetch: options.fetch,
    now: () => clock.now,
    load: async () => options.kept ?? { skipped: null, snoozedUntil: 0 },
    save: async (kept) => void saved.push(kept),
    changed: (state) => void told.push(state),
  });
  return { instance, saved, told, clock };
};

describe('versions', () => {
  it('knows a later version, a pre-release from its release, and an unreadable one as never newer', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.3')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('v0.1.1', '0.1.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
    expect(isNewer('0.2.0', '0.2.0-beta.2')).toBe(true);
    expect(isNewer('0.2.0-beta.10', '0.2.0-beta.2')).toBe(true);
    expect(isNewer('0.2.0-beta.1', '0.2.0')).toBe(false);
    expect(isNewer('latest', '0.1.0')).toBe(false);
    expect([releasePlatform('win32'), releasePlatform('darwin'), releasePlatform('linux')]).toEqual(['windows', 'macos', null]);
  });
});

describe('the update check', () => {
  it('offers the newer release for this platform, with its notes, and nothing when this copy is current', async () => {
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      return respond([
        { platform: 'macos', version: '0.3.0' },
        { platform: 'windows', version: '0.2.0', release_notes: 'Frame.io publishing.\nFaster ingest.', minimum_os_version: 'Windows 10' },
      ]);
    }) as unknown as typeof fetch;
    const { instance, told } = updater({ fetch: fetcher });
    await instance.start();
    const state = await instance.check();
    expect(asked).toEqual(['https://vc-dit.com/api/releases']);
    expect(state).toMatchObject({ current: '0.1.0', showing: true, checking: false, error: null, available: { version: '0.2.0', notes: 'Frame.io publishing.\nFaster ingest.', minimumOs: 'Windows 10' } });
    expect(told.map((each) => each.checking)).toEqual([true, false]);

    const current = updater({ current: '0.2.0', fetch: releases([{ platform: 'windows', version: '0.2.0' }]) });
    expect(await current.instance.check()).toMatchObject({ available: null, showing: false, error: null });
    // A platform with no installers (a developer on Linux) does not ask at all.
    const linux = updater({ platform: null, fetch: (async () => { throw new Error('should not be asked'); }) as unknown as typeof fetch });
    expect(await linux.instance.check()).toMatchObject({ available: null, checkedAt: null });
  });

  it('says why a check did not answer, and keeps what it knew', async () => {
    let online = true;
    const fetcher = (async () => {
      if (!online) throw new TypeError('fetch failed');
      return respond([{ platform: 'windows', version: '0.2.0' }]);
    }) as unknown as typeof fetch;
    const { instance } = updater({ fetch: fetcher });
    await instance.check();
    online = false;
    expect(await instance.check()).toMatchObject({ error: 'VC DIT could not reach vc-dit.com.', available: { version: '0.2.0' }, showing: true });
    const down = updater({ fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch });
    expect(await down.instance.check()).toMatchObject({ error: 'Could not check: the site answered 503.', available: null });
  });

  it('puts the notice off until tomorrow, skips a version for good, and announces the next one', async () => {
    let latest = '0.2.0';
    const fetcher = (async () => respond([{ platform: 'windows', version: latest }])) as unknown as typeof fetch;
    const { instance, saved, clock } = updater({ fetch: fetcher });
    await instance.start();
    await instance.check();
    expect((await instance.dismiss('later')).showing).toBe(false);
    expect(saved.at(-1)).toEqual({ skipped: null, snoozedUntil: clock.now + DAY });
    clock.now += DAY - 1000;
    expect((await instance.check()).showing).toBe(false);
    clock.now += 2000;
    expect((await instance.check()).showing).toBe(true);
    expect((await instance.dismiss('skip')).showing).toBe(false);
    expect(saved.at(-1)?.skipped).toBe('0.2.0');
    expect((await instance.check()).showing).toBe(false);
    latest = '0.2.1';
    expect(await instance.check()).toMatchObject({ showing: true, available: { version: '0.2.1' } });
  });

  it('remembers a skipped version across a restart', async () => {
    const { instance } = updater({ fetch: releases([{ platform: 'windows', version: '0.2.0' }]), kept: { skipped: '0.2.0', snoozedUntil: 0 } });
    await instance.start();
    expect(await instance.check()).toMatchObject({ available: { version: '0.2.0' }, showing: false });
  });
});
