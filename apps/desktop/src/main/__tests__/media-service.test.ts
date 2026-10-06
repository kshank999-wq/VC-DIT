import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestRequest, MediaState } from '../../shared/media';
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
    platform: 'linux',
    pollEveryMs: 60_000,
    mounts: async () => mounts.map((path) => ({ path, name: path.split(/[\\/]/).pop()! })),
    startWorker: (plan) => inProcess(plan, corrupt),
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
    expect(await readdir(join(base, 'appdata', 'transfers'))).toHaveLength(1);
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
});
