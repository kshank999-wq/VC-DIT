import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestRequest, MediaState } from '../../shared/media';
import type { TransferRecord } from '../db/production-db';
import { MediaService, type TransferRunner } from '../media/media-service';
import { writeReports } from '../media/reports';
import { runTransfer } from '../media/transfer';
import type { WorkerMessage, WorkerPlan } from '../media/transfer-worker';

/** The worker thread, run in-process: same messages, same order. */
const inProcess = (plan: WorkerPlan, corrupt: { path: string; leg: string } | null): TransferRunner => {
  const events = new EventEmitter();
  const controller = new AbortController();
  setImmediate(async () => {
    const result = await runTransfer(plan.sourceRoot, plan.files, plan.legs, plan.method, {
      signal: controller.signal,
      sourceLost: plan.sourceLost,
      onProgress: (progress) => events.emit('message', { type: 'progress', progress } satisfies WorkerMessage),
      afterCopy: async (legId, written, file) => {
        if (corrupt && legId === corrupt.leg && file.path === corrupt.path) await writeFile(written, 'damaged');
      },
    });
    const reports = await writeReports(result, plan.legs, plan.contexts, plan.allLegs);
    events.emit('message', { type: 'done', result, reports } satisfies WorkerMessage);
    events.emit('exit', 0);
  });
  return Object.assign(events, { postMessage: () => controller.abort() }) as unknown as TransferRunner;
};

let base: string;
let licensed: boolean;
let corrupt: { path: string; leg: string } | null;
let mounts: string[];
let service: MediaService;
let states: MediaState[];
let records: TransferRecord[];
let plans: WorkerPlan[];

const settle = () =>
  vi.waitFor(
    () => {
      if (service.busy()) throw new Error('still copying');
    },
    { timeout: 5000, interval: 10 },
  );

const request = (sources: string[], destinations: string[]): IngestRequest => ({
  sources,
  destinations,
  checksum: 'xxHash64',
  production: { name: 'HALCYON', code: 'HLC' },
  day: { number: 14, date: '2026-10-05' },
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vcdit-service-'));
  licensed = true;
  corrupt = null;
  states = [];
  records = [];
  plans = [];
  const card = join(base, 'A015');
  await mkdir(join(card, 'A015R1AB'), { recursive: true });
  await writeFile(join(card, 'A015R1AB', 'A015C001_261005_R1AB.mxf'), 'take one');
  await writeFile(join(card, 'A015R1AB', 'A015C002_261005_R1AB.mxf'), 'take two');
  await mkdir(join(base, 'RAID'));
  await mkdir(join(base, 'SHUTTLE'));
  mounts = [card, join(base, 'RAID'), join(base, 'SHUTTLE')];
  service = new MediaService({
    dataDir: join(base, 'appdata'),
    workerPath: 'unused',
    tool: { name: 'VC DIT', version: 'test' },
    canStartTransfers: () => licensed,
    onChange: (state) => states.push(state),
    onRecord: (record) => records.push(structuredClone(record)),
    platform: 'linux',
    pollEveryMs: 60_000,
    mounts: async () => mounts.map((path) => ({ path, name: path.split(/[\\/]/).pop()! })),
    startWorker: (plan) => {
      plans.push(plan);
      return inProcess(plan, corrupt);
    },
  });
  await service.start();
  await vi.waitFor(() => expect(service.state().volumes).toHaveLength(3));
  await service.setRole(join(base, 'RAID'), 'Destination');
  await service.setRole(join(base, 'SHUTTLE'), 'Shuttle');
});

afterEach(async () => {
  service.stop();
  await rm(base, { recursive: true, force: true });
});

describe('the media service', () => {
  it('recognises the card and remembers roles given to volumes', async () => {
    const card = service.state().volumes.find((volume) => volume.name === 'A015')!;
    expect(card).toMatchObject({ role: 'Camera', suggestedRole: 'Camera', detected: 'ARRI · MXF', ingested: false });
    expect(service.state().volumes.find((volume) => volume.name === 'RAID')!.role).toBe('Destination');
  });

  it('ingests a card to two destinations: safe to format once both verify, with logs on each', async () => {
    const result = await service.ingest(request([mounts[0]!], [mounts[1]!, mounts[2]!]));
    expect(result).toEqual({ ok: true, jobs: ['A015'] });
    await settle();
    const job = service.state().jobs[0]!;
    expect(job).toMatchObject({ id: 'A015', fileCount: 2, totalBytes: 16, running: false, queued: false });
    expect(job.legs.map((leg) => [leg.name, leg.copyPct, leg.verifyPct, leg.failed])).toEqual([
      ['RAID', 100, 100, false],
      ['SHUTTLE', 100, 100, false],
    ]);
    const reports = join(base, 'RAID', 'HALCYON', 'SHOOT_DAY_014_2026-10-05', 'REPORTS', 'ingest_verification');
    expect((await readdir(reports)).sort().map((name) => name.replace(/\d{8}_\d{6}Z/, 'T'))).toEqual(['A015_T.csv', 'A015_T.json']);
    // Kept in the production database when queued, and again with every result when done.
    expect(records.map((record) => record.finishedAt === null)).toEqual([true, false]);
    expect(records[1]).toMatchObject({ id: 'A015', day: 14, card: 'A015', sound: false, checksum: 'xxHash64' });
    expect(records[1]!.files.map((file) => file.hash)).toEqual([expect.stringMatching(/^[0-9a-f]{16}$/), expect.stringMatching(/^[0-9a-f]{16}$/)]);
    expect(Object.values(records[1]!.destinations[0]!.outcomes)).toEqual([{ state: 'verified' }, { state: 'verified' }]);
    expect(service.state().volumes.find((volume) => volume.name === 'A015')!.ingested).toBe(true);
    // The screens heard about it as it went.
    expect(states.some((state) => state.jobs[0]?.running)).toBe(true);
  });

  it('marks a destination failed when a copy does not verify, and a retry copies just that file again', async () => {
    corrupt = { path: 'A015R1AB/A015C002_261005_R1AB.mxf', leg: mounts[2]! };
    await service.ingest(request([mounts[0]!], [mounts[1]!, mounts[2]!]));
    await settle();
    let legs = service.state().jobs[0]!.legs;
    expect(legs[0]!.failed).toBe(false);
    expect(legs[1]).toMatchObject({ failed: true, problemFiles: 1, error: expect.stringMatching(/1 file did not verify: Checksum mismatch/) });

    corrupt = null;
    expect(service.retry('A015', 'SHUTTLE')).toEqual({ ok: true, jobs: ['A015'] });
    await settle();
    legs = service.state().jobs[0]!.legs;
    expect(legs[1]).toMatchObject({ failed: false, copyPct: 100, verifyPct: 100, error: null });
  });

  it('refuses what must not happen', async () => {
    const [card, raid, shuttle] = mounts as [string, string, string];
    licensed = false;
    expect(await service.ingest(request([card], [raid]))).toEqual({ ok: false, reason: expect.stringMatching(/Activate/) });
    licensed = true;
    expect(await service.ingest(request([raid], [shuttle]))).toEqual({ ok: false, reason: expect.stringMatching(/not marked as a camera or sound card/) });
    await service.setRole(shuttle, 'Sound');
    expect(await service.ingest(request([card], [shuttle]))).toEqual({ ok: false, reason: expect.stringMatching(/not marked as a destination/) });
    // A folder on a card can't even be added as a destination.
    expect(await service.addFolder(join(card, 'A015R1AB'))).toEqual({ ok: false, reason: expect.stringMatching(/never written/) });
    expect(await service.ingest(request([card], [raid, raid]))).toEqual({ ok: false, reason: expect.stringMatching(/picked twice/) });
    expect(service.state().jobs).toHaveLength(0);
  });

  it('will not change the role of a card while it is being copied', async () => {
    await service.ingest(request([mounts[0]!], [mounts[1]!]));
    expect(await service.setRole(mounts[0]!, 'Destination')).toEqual({ ok: false, reason: expect.stringMatching(/transfer is using/) });
    await settle();
    expect(await service.setRole(mounts[0]!, 'Other')).toEqual({ ok: true });
  });

  it('takes folders as destinations, and a second ingest of the same card gets its own entry', async () => {
    const folder = join(base, 'NAS', 'Dailies');
    await mkdir(folder, { recursive: true });
    expect(await service.addFolder(folder)).toEqual({ ok: true });
    const id = service.state().folders[0]!.id;
    expect(service.state().folders[0]).toMatchObject({ name: 'Dailies', online: true });
    await service.ingest(request([mounts[0]!], [id]));
    await settle();
    await service.ingest(request([mounts[0]!], [id]));
    await settle();
    const jobs = service.state().jobs;
    expect(jobs.map((job) => job.id)).toEqual(['A015', 'A015 (2)']);
    // The second pass found the first one's verified copies and kept them.
    expect(jobs[1]!.legs[0]).toMatchObject({ failed: false, verifyPct: 100 });
  });

  it('shows a day\'s kept transfers after a restart, and one cut off mid-copy as failed until it is copied again', async () => {
    await service.ingest(request([mounts[0]!], [mounts[1]!]));
    await settle();
    const finished = records.at(-1)!;
    const cutOff: TransferRecord = { ...structuredClone(records[0]!), id: 'B010', card: 'B010', destinations: records[0]!.destinations.map((d) => ({ ...d, outcomes: {} })) };

    expect(service.load([finished, cutOff])).toBe(true);
    const [done, broken] = service.state().jobs;
    expect(done).toMatchObject({ id: 'A015', queued: false, running: false });
    expect(done!.legs[0]).toMatchObject({ failed: false, verifyPct: 100 });
    expect(broken!.legs[0]).toMatchObject({ failed: true, error: expect.stringMatching(/closed before this transfer finished/) });

    // Copying it again from the card (here the same card stands in for it) puts it right.
    expect(service.retry('B010', mounts[1]!)).toEqual({ ok: true, jobs: ['B010'] });
    await settle();
    expect(service.state().jobs[1]!.legs[0]).toMatchObject({ failed: false, verifyPct: 100 });
    // A new ingest of a card already listed today gets its own entry.
    await service.ingest(request([mounts[0]!], [mounts[1]!]));
    expect(service.state().jobs.map((job) => job.id)).toEqual(['A015', 'B010', 'A015 (2)']);
    await settle();
  });

  it('will not swap the day\'s transfers while one is running', async () => {
    await service.ingest(request([mounts[0]!], [mounts[1]!]));
    expect(service.load([])).toBe(false);
    await settle();
    expect(service.load([])).toBe(true);
    expect(service.state().jobs).toEqual([]);
  });
});

describe('uploads relayed from the backup', () => {
  const cloudDir = () => join(base, 'Dropbox', 'Dailies');
  const addCloud = async () => {
    await mkdir(cloudDir(), { recursive: true });
    expect(await service.addFolder(cloudDir())).toEqual({ ok: true });
    return `folder:${cloudDir()}`;
  };
  const uploaded = (name: string) => join(cloudDir(), 'HALCYON', 'SHOOT_DAY_014_2026-10-05', 'CAMERA_ORIGINALS', 'A015', 'A015R1AB', name);
  const onRaid = (name: string) => join(base, 'RAID', 'HALCYON', 'SHOOT_DAY_014_2026-10-05', 'CAMERA_ORIGINALS', 'A015', 'A015R1AB', name);

  it('feeds a cloud folder from the verified RAID, not the card, checking each file against the card', async () => {
    const cloud = await addCloud();
    // A Dropbox folder is an upload unless the operator says otherwise; the RAID is fed from the card.
    expect(service.state().folders[0]!.relay).toBe(true);
    expect(service.state().volumes.find((volume) => volume.name === 'RAID')!.relay).toBe(false);

    expect(await service.ingest(request([mounts[0]!], [mounts[1]!, mounts[2]!, cloud]))).toEqual({ ok: true, jobs: ['A015'] });
    await settle();
    const job = service.state().jobs[0]!;
    expect(job.legs.map((leg) => [leg.name, leg.relay, leg.relayFrom, leg.failed, leg.copyPct, leg.verifyPct])).toEqual([
      ['RAID', false, null, false, 100, 100],
      ['SHUTTLE', false, null, false, 100, 100],
      ['Dailies', true, 'RAID', false, 100, 100],
    ]);
    // Two runs: the card to RAID and SHUTTLE, then the RAID's copy to the cloud, each file expected to match the card.
    expect(plans.map((plan) => [plan.sourceRoot, plan.legs.map((leg) => leg.name)])).toEqual([
      [mounts[0], ['RAID', 'SHUTTLE']],
      [join(base, 'RAID', 'HALCYON', 'SHOOT_DAY_014_2026-10-05', 'CAMERA_ORIGINALS', 'A015'), ['Dailies']],
    ]);
    expect(plans[1]!.files.every((file) => typeof file.expected === 'string' && file.expected.length > 0)).toBe(true);
    expect(await readFile(uploaded('A015C002_261005_R1AB.mxf'), 'utf8')).toBe('take two');
    // Kept as an upload from the RAID.
    expect(records.at(-1)!.destinations[2]).toMatchObject({ relay: true, relayFrom: mounts[1], error: null });
    expect(service.relaysPending()).toBe(0);
  });

  it('will not upload a backup copy that no longer matches the card', async () => {
    const cloud = await addCloud();
    await service.pauseRelays(true);
    await service.ingest(request([mounts[0]!], [mounts[1]!, mounts[2]!, cloud]));
    await settle();
    // The card is done; the upload waits, paused.
    let job = service.state().jobs[0]!;
    expect(job.legs[2]).toMatchObject({ relay: true, waiting: 'Paused', failed: false });
    expect(service.relaysPending()).toBe(1);
    // Something changes the RAID's copy before the upload reads it.
    await writeFile(onRaid('A015C001_261005_R1AB.mxf'), 'tampered');
    await service.pauseRelays(false);
    await settle();
    job = service.state().jobs[0]!;
    expect(job.legs[2]).toMatchObject({ failed: true, problemFiles: 1 });
    expect(job.legs[2]!.error).toMatch(/no longer matches the checksum/);
    expect(await readFile(uploaded('A015C002_261005_R1AB.mxf'), 'utf8')).toBe('take two');
    await expect(readFile(uploaded('A015C001_261005_R1AB.mxf'))).rejects.toThrow();
  });

  it('waits for an unplugged backup, then carries on when it is back', async () => {
    const cloud = await addCloud();
    await service.pauseRelays(true);
    await service.ingest(request([mounts[0]!], [mounts[1]!, mounts[2]!, cloud]));
    await settle();
    await rename(join(base, 'RAID'), join(base, 'RAID-away'));
    await service.pauseRelays(false);
    expect(service.state().jobs[0]!.legs[2]!.waiting).toBe('Waiting for RAID: plug it back in to carry on.');
    expect(service.busy()).toBe(false);
    await rename(join(base, 'RAID-away'), join(base, 'RAID'));
    await service.poll();
    await settle();
    expect(service.state().jobs[0]!.legs[2]).toMatchObject({ failed: false, copyPct: 100, verifyPct: 100, waiting: null });
  });

  it('carries on after a restart from what the database kept, uploading only what was left', async () => {
    const cloud = await addCloud();
    await service.pauseRelays(true);
    await service.ingest(request([mounts[0]!], [mounts[1]!, mounts[2]!, cloud]));
    await settle();
    const kept = records.at(-1)!;
    expect(kept.finishedAt).not.toBeNull();
    expect(Object.keys(kept.destinations[2]!.outcomes)).toEqual([]);
    service.stop();

    // A new start of the app, uploads not paused there.
    const again = new MediaService({
      dataDir: join(base, 'appdata-2'),
      workerPath: 'unused',
      tool: { name: 'VC DIT', version: 'test' },
      canStartTransfers: () => true,
      onChange: () => undefined,
      onRecord: (record) => records.push(structuredClone(record)),
      platform: 'linux',
      pollEveryMs: 60_000,
      mounts: async () => mounts.map((path) => ({ path, name: path.split(/[\\/]/).pop()! })),
      startWorker: (plan) => {
        plans.push(plan);
        return inProcess(plan, null);
      },
    });
    await again.start();
    service = again;
    expect(again.load([kept])).toBe(true);
    await settle();
    expect(again.state().jobs[0]!.legs[2]).toMatchObject({ relay: true, relayFrom: 'RAID', failed: false, copyPct: 100, verifyPct: 100 });
    expect(await readFile(uploaded('A015C001_261005_R1AB.mxf'), 'utf8')).toBe('take one');
  });

  it('stops one upload for good until it is retried, then sends it from the backup', async () => {
    const cloud = await addCloud();
    await service.pauseRelays(true);
    await service.ingest(request([mounts[0]!], [mounts[1]!, mounts[2]!, cloud]));
    await settle();
    expect(service.stopJob('A015', cloud)).toEqual({ ok: true });
    expect(service.state().jobs[0]!.legs[2]).toMatchObject({ failed: true, error: 'Upload stopped. Retry to carry on from the backup.' });
    await service.pauseRelays(false);
    expect(service.busy()).toBe(false);
    expect(service.retry('A015', cloud)).toEqual({ ok: true, jobs: ['A015'] });
    await settle();
    expect(service.state().jobs[0]!.legs[2]).toMatchObject({ failed: false, copyPct: 100, verifyPct: 100 });
  });

  it('needs one destination fed from the card, and remembers the choice', async () => {
    const cloud = await addCloud();
    expect(await service.ingest(request([mounts[0]!], [cloud]))).toEqual({
      ok: false,
      reason: 'Pick at least one destination that copies straight from the card, like the RAID. Uploads are fed from it once the card has verified there.',
    });
    expect(await service.setRelay(cloud, false)).toEqual({ ok: true });
    expect(service.state().folders[0]!.relay).toBe(false);
    expect(await service.setRelay(mounts[2]!, true)).toEqual({ ok: true });
    expect(service.state().volumes.find((volume) => volume.name === 'SHUTTLE')!.relay).toBe(true);
  });
});
