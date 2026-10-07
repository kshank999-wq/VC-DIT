import { copyFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProductionDb, type TransferRecord } from '../db/production-db';
import { parseScriptLog } from '../scriptlog/parse';
import { analyse, readFirstMeta } from '../sync/analyse';
import { SyncService, type RunAnalysis } from '../sync/sync-service';
// @ts-expect-error a plain JS helper shared with the fixture script
import { burstSignal, RATE, wavBytes } from './fixtures/signal.mjs';

/**
 * Sync end to end on real files: an MOV and an MXF made by ffmpeg (2 s at
 * 23.976, timecode 14:05:40:12, scratch audio = seconds 2.5–4.5 of the test
 * sound) and a Broadcast WAV of the whole sound.
 */

const wasm = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
const FPS = 24000 / 1001;
/** The sound file starts 60 timecode frames before the clips: 14:05:38:00. */
const SOUND_START_FRAMES = ((14 * 60 + 5) * 60 + 38) * 24;
const runAnalysis: RunAnalysis = async (jobs) => Promise.all(jobs.map((job) => (job.kind === 'meta' ? readFirstMeta(job.paths) : analyse(job.task))));

let base: string;
let db: ProductionDb;
let sync: SyncService;

/** Cards on disk, recorded as ingested (read from where they are). */
const ingest = async (card: string, sound: boolean, files: { name: string; from?: string; bytes?: Buffer }[]) => {
  const root = join(base, card);
  await mkdir(join(root, 'CLIPS'), { recursive: true });
  const listed: TransferRecord['files'] = [];
  for (const file of files) {
    const path = join(root, 'CLIPS', file.name);
    if (file.from) await copyFile(join(__dirname, 'fixtures', file.from), path);
    else await writeFile(path, file.bytes!);
    // Camera and recorder stopped within a minute of each other.
    await utimes(path, new Date('2026-10-07T14:06:00'), new Date('2026-10-07T14:06:00'));
    listed.push({ path: `CLIPS/${file.name}`, size: (await stat(path)).size, mtimeMs: (await stat(path)).mtimeMs, hash: null, hashedAt: null });
  }
  db.saveTransfer({ id: card, day: 1, card, label: card, sourceRoot: root, sound, checksum: 'xxHash64', startedAt: 'x', finishedAt: 'y', files: listed, destinations: [] });
};

const wav = (startFrames: number | null) =>
  wavBytes(burstSignal(8), { timeReference: startFrames === null ? null : Math.round((startFrames / FPS) * RATE) });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vcdit-sync-'));
  db = await ProductionDb.open(join(base, 'p.vcdit'), { wasm, create: { frameRate: '23.976 fps' } });
  sync = new SyncService({ db: () => db, runAnalysis, changed: () => undefined });
});
afterEach(async () => {
  await db.close();
  await rm(base, { recursive: true, force: true });
});

describe('sync', () => {
  it('syncs MOV and MXF clips by timecode, checked against the waveform, and accepts them', async () => {
    await ingest('A001', false, [
      { name: 'A001C001_261007_R1AB.mov', from: 'clip.mov' },
      { name: 'A001C002_261007_R1AB.mxf', from: 'clip.mxf' },
    ]);
    await ingest('S001', true, [{ name: '14B-03.WAV', bytes: wav(SOUND_START_FRAMES) }]);
    db.importLog(1, 'log.csv', parseScriptLog('log.csv', 'Scene,Setup,Take,Clip\n14,B,3,A001C001\n'));
    await sync.run();

    const view = db.syncView(1);
    expect(view.map((entry) => [entry.take, entry.clip, entry.sound, entry.method, entry.offsetFrames, entry.confidence, entry.accepted])).toEqual([
      ['14B-03', 'A001C001', '14B-03', 'Timecode', 0, 99, true],
      ['A001C002', 'A001C002', '14B-03', 'Timecode', 0, 99, true],
    ]);
    expect(view[0]!.why).toMatch(/covers the whole clip; the waveform agrees/);
    expect(view[0]!.fps).toBeCloseTo(FPS, 3);
    expect(view[0]!.barsPicture.length).toBe(160);
    expect(view[0]!.barsSound.length).toBe(160);
    // The sound starts 60 frames before the clip.
    expect(db.syncRecords(1).find((record) => record.clipKey === 'A001C001')!.alignFrames).toBeCloseTo(-60, 0);
    // The take now shows its sound and that it is synced by timecode.
    const take = db.logView(1).scenes.find((scene) => scene.id === '14')!.setups[0]!.takes[0]!;
    expect(take).toMatchObject({ sync: 'TC', sound: '14B-03' });

    // Nothing changed: a second run does no work and keeps everything.
    await sync.run();
    expect(db.syncView(1)).toEqual(view);
  });

  it("catches a recorder whose timecode was not jammed: timecode pairs it, the waveform disagrees, it waits for a look", async () => {
    await ingest('A001', false, [{ name: 'A001C001_261007_R1AB.mov', from: 'clip.mov' }]);
    // The recorder's clock runs one second (24 frames) behind.
    await ingest('S001', true, [{ name: '14B-03.WAV', bytes: wav(SOUND_START_FRAMES - 24) }]);
    await sync.run();
    const [entry] = db.syncView(1);
    expect(entry).toMatchObject({ method: 'Timecode', accepted: false, confidence: 70 });
    expect(entry!.why).toMatch(/disagree by 24 frames.*\+24 fr/);
  });

  it('leaves a clip timecode cannot place for the waveform pass, which finds it; the DIT nudges and accepts', async () => {
    await ingest('A001', false, [{ name: 'A001C001_261007_R1AB.mov', from: 'clip.mov' }]);
    // A WAV with no timecode at all.
    await ingest('S001', true, [{ name: 'T001.WAV', bytes: wav(null) }]);
    await sync.run();
    expect(db.syncView(1)[0]).toMatchObject({ method: 'None', sound: '—', confidence: 0, why: "No sound file's timecode overlaps this clip. Try the waveform pass." });

    await sync.run({ waveform: true });
    const found = db.syncView(1)[0]!;
    expect(found).toMatchObject({ method: 'Waveform', sound: 'T001', accepted: false, offsetFrames: 0 });
    expect(found.confidence).toBeGreaterThan(60);
    expect(found.confidence).toBeLessThan(90);
    expect(db.syncRecords(1)[0]!.alignFrames).toBeCloseTo(-2.5 * FPS, 0);

    db.nudgeSync(1, found.id, 2);
    expect(db.syncView(1)[0]).toMatchObject({ method: 'Manual', offsetFrames: 2, accepted: false });
    db.acceptSync(1, [found.id]);
    expect(db.syncView(1)[0]).toMatchObject({ accepted: true });
    // What the DIT decided is never redone.
    await sync.run({ waveform: true });
    expect(db.syncView(1)[0]).toMatchObject({ method: 'Manual', offsetFrames: 2, accepted: true });
  });

  it('says why a clip cannot be synced', async () => {
    await ingest('A001', false, [
      { name: 'A001C001_261007_R1AB.mov', from: 'clip.mov' },
      { name: 'A001_C002_1007XY_001.R3D', bytes: Buffer.from('red') },
    ]);
    await sync.run();
    expect(Object.fromEntries(db.syncView(1).map((entry) => [entry.clip, entry.why]))).toEqual({
      A001C001: 'No sound files ingested today yet.',
      A001C002: expect.stringMatching(/RED SDK/),
    });
  });

  it('places a logged take with no clip name once the clip\'s timecode is read', async () => {
    await ingest('A001', false, [{ name: 'A001C001_261007_R1AB.mov', from: 'clip.mov' }]);
    db.importLog(1, 'log.csv', parseScriptLog('log.csv', 'Scene,Setup,Take,Roll,TC In\n14,B,3,A001,14:05:41:00\n'));
    expect(db.logView(1).log).toMatchObject({ matched: 0, review: 1 });
    await sync.run();
    expect(db.logView(1).log).toMatchObject({ matched: 1, review: 0 });
    expect(db.logView(1).scenes.find((scene) => scene.id === '14')!.setups[0]!.takes[0]).toMatchObject({ clipA: 'A001C001', match: 'Matched' });
  });
});
