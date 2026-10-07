import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DAILIES, type DailiesSettings } from '../../shared/project';
import { DailiesService } from '../dailies/dailies-service';
import { ProductionDb, type TransferRecord } from '../db/production-db';
import { locateFfmpeg } from '../ffmpeg/ffmpeg';
import { readMediaMeta } from '../media/metadata';
import { parseScriptLog } from '../scriptlog/parse';
import { analyse, readFirstMeta } from '../sync/analyse';
import { SyncService, type RunAnalysis } from '../sync/sync-service';
import { tintCube } from './fixtures/luts';
// @ts-expect-error a plain JS helper shared with the fixture script
import { burstSignal, RATE, wavBytes } from './fixtures/signal.mjs';

const wasm = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
const FONT = join(__dirname, '..', '..', '..', 'build', 'fonts', 'IBMPlexMono-Medium.ttf');
const FPS = 24000 / 1001;
const runAnalysis: RunAnalysis = async (jobs) => Promise.all(jobs.map((job) => (job.kind === 'meta' ? readFirstMeta(job.paths) : analyse(job.task))));
const ffmpeg = await locateFfmpeg(null);

let base: string;
let db: ProductionDb;
let dailies: DailiesService;

const ingest = async (card: string, sound: boolean, files: { name: string; from?: string; bytes?: Buffer }[]) => {
  const root = join(base, 'cards', card);
  await mkdir(join(root, 'CLIPS'), { recursive: true });
  const listed: TransferRecord['files'] = [];
  for (const file of files) {
    const path = join(root, 'CLIPS', file.name);
    if (file.from) await copyFile(join(__dirname, 'fixtures', file.from), path);
    else await writeFile(path, file.bytes!);
    await utimes(path, new Date('2026-10-07T14:06:00'), new Date('2026-10-07T14:06:00'));
    listed.push({ path: `CLIPS/${file.name}`, size: (await stat(path)).size, mtimeMs: (await stat(path)).mtimeMs, hash: null, hashedAt: null });
  }
  db.saveTransfer({ id: card, day: 1, card, label: card, sourceRoot: root, sound, checksum: 'xxHash64', startedAt: 'x', finishedAt: 'y', files: listed, destinations: [] });
};

const settings = (patch: Partial<DailiesSettings> = {}): DailiesSettings => ({
  ...DEFAULT_DAILIES,
  destination: 'raid',
  resolution: '1280 × 720 · letterbox 2.39',
  burnIns: { ...DEFAULT_DAILIES.burnIns, Watermark: true },
  ...patch,
});

const finished = () => vi.waitFor(() => expect(dailies.busy()).toBe(false), { timeout: 20000, interval: 50 });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vcdit-dailies-'));
  db = await ProductionDb.open(join(base, 'p.vcdit'), { wasm, create: { name: 'NIGHTJAR', code: 'NJR', frameRate: '23.976 fps' } });
  db.updateDay(1, { date: '2026-10-07' });
  await mkdir(join(base, 'RAID'));
  dailies = new DailiesService({
    db: () => db,
    ffmpeg: async () => ffmpeg,
    font: FONT,
    destination: (id) => (id === 'raid' ? { name: 'RAID', root: join(base, 'RAID') } : null),
    changed: () => undefined,
  });
  await ingest('A001', false, [
    { name: 'A001C001_261007_R1AB.mov', from: 'clip.mov' },
    { name: 'A001C002_261007_R1AB.mxf', from: 'clip.mxf' },
  ]);
  await ingest('S001', true, [{ name: '14B-03.WAV', bytes: wavBytes(burstSignal(8), { timeReference: Math.round(((((14 * 60 + 5) * 60 + 38) * 24) / FPS) * RATE) }) }]);
  db.importLog(1, 'log.csv', parseScriptLog('log.csv', 'Scene,Setup,Take,Clip,Circle\n14,B,3,A001C001,Y\n21,A,1,A001C002,\n'));
  await new SyncService({ db: () => db, runAnalysis, changed: () => undefined }).run();
});
afterEach(async () => {
  await db.close();
  await rm(base, { recursive: true, force: true });
});

describe('the LUT library', () => {
  it('keeps LUTs in the production, makes the first the default, and refuses a different file under the same name', () => {
    const warm = db.importLut('Warm.cube', tintCube);
    expect(db.importLut('Warm.cube', tintCube)).toBe(warm);
    expect(() => db.importLut('Warm.cube', tintCube.replace('0.2 0 0', '0.3 0 0'))).toThrow(/different Warm\.cube/);
    expect(() => db.importLut('Broken.cube', 'LUT_3D_SIZE 2\n')).toThrow(/needs 8 rows/);
    expect(db.luts()).toEqual([expect.objectContaining({ id: warm, name: 'Warm.cube', title: 'Warm test', kind: '3D', size: 2, isDefault: true })]);
    expect(db.lutRules(1)).toEqual([expect.objectContaining({ scope: 'Project', target: 'Default', lut: 'Warm.cube', clips: 2 })]);
  });

  it('gives each clip the look of the most specific rule', () => {
    const warm = db.importLut('Warm.cube', tintCube);
    const cool = db.importLut('Cool.cube', tintCube.replace('Warm test', 'Cool test'));
    const night = db.importLut('Night.cube', tintCube.replace('Warm test', 'Night'));
    db.setLutRule('Camera', 'a', cool);
    db.setLutRule('Scene', '21', night);
    const looks = () => Object.fromEntries(db.dailiesPlan(1, settings({ include: 'all' })).map((plan) => [plan.clip, plan.lut?.name ?? null]));
    expect(looks()).toEqual({ A001C001: 'Cool.cube', A001C002: 'Night.cube' });
    db.setLutRule('Clip', 'a001c001', warm);
    expect(looks()).toEqual({ A001C001: 'Warm.cube', A001C002: 'Night.cube' });
    expect(db.lutRules(1).map((rule) => [rule.scope, rule.target, rule.clips])).toEqual([
      ['Project', 'Default', 0],
      ['Camera', 'A', 0],
      ['Scene', '21', 1],
      ['Clip', 'A001C001', 1],
    ]);
    expect(Object.values(Object.fromEntries(db.dailiesPlan(1, settings({ include: 'all', look: 'Project default only' })).map((plan) => [plan.clip, plan.lut?.name])))).toEqual(['Warm.cube', 'Warm.cube']);
    db.removeLut(warm);
    expect(db.lutRules(1).map((rule) => rule.scope)).toEqual(['Camera', 'Scene']);
  });

  it('plans circle takes, all takes, or chosen scenes, each with its synced sound', () => {
    const circle = db.dailiesPlan(1, settings());
    expect(circle.map((plan) => [plan.label, plan.clip, plan.circle, plan.sound?.key, plan.sound?.accepted])).toEqual([['14B-03', 'A001C001', true, '14B-03', true]]);
    expect(db.dailiesPlan(1, settings({ include: 'all' })).map((plan) => plan.label)).toEqual(['14B-03', '21A-01']);
    expect(db.dailiesPlan(1, settings({ include: 'scene', scenes: ['21'] })).map((plan) => plan.label)).toEqual(['21A-01']);
  });
});

describe.skipIf(!ffmpeg)('dailies, rendered', () => {
  it('renders the circle take with its look and sound, hashes it, copies the look and writes a manifest', async () => {
    db.importLut('Warm.cube', tintCube);
    await dailies.start(settings());
    await finished();
    const [render] = db.renders(1);
    const dayDir = join(base, 'RAID', 'NIGHTJAR', 'SHOOT_DAY_001_2026-10-07');
    expect(render).toMatchObject({
      label: '14B-03',
      clip: 'A001C001',
      state: 'done',
      error: null,
      lut: 'Warm.cube',
      codec: 'ProRes 422 Proxy',
      output: join(dayDir, 'SYNCED_DAILIES', 'SCENE_014', 'SETUP_B', '14B-03_A001C001.mov'),
      checksum: expect.stringMatching(/^[0-9a-f]{16}$/),
      warnings: [],
    });
    expect(await readMediaMeta(render!.output)).toEqual({ ok: true, meta: expect.objectContaining({ tc: { frames: 1217772, base: 24, dropFrame: false } }) });
    expect(await readFile(join(dayDir, 'LUTS_LOOKS', 'Warm.cube'), 'utf8')).toBe(tintCube);
    const [manifest] = await readdir(join(dayDir, 'REPORTS', 'dailies'));
    expect(await readFile(join(dayDir, 'REPORTS', 'dailies', manifest!), 'utf8')).toContain(`14B-03,A001C001,${render!.output},done,ProRes 422 Proxy,Warm.cube,14B-03,`);
    // Nothing left half-written.
    expect((await readdir(join(dayDir, 'SYNCED_DAILIES', 'SCENE_014', 'SETUP_B'))).filter((name) => name.endsWith('.vcdit-part'))).toEqual([]);

    // Rendering again replaces its own daily.
    await dailies.start(settings({ codec: 'DNxHR LB' }));
    await finished();
    expect(db.renders(1)[0]).toMatchObject({ state: 'done', codec: 'DNxHR LB' });
  });

  it("never replaces a file it did not make, and says why it cannot start", async () => {
    const folder = join(base, 'RAID', 'NIGHTJAR', 'SHOOT_DAY_001_2026-10-07', 'SYNCED_DAILIES', 'SCENE_014', 'SETUP_B');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, '14B-03_A001C001.mov'), 'editorial put this here');
    await dailies.start(settings());
    await finished();
    expect(db.renders(1)[0]).toMatchObject({ state: 'failed', error: expect.stringMatching(/not made by VC DIT/) });
    expect(await readFile(join(folder, '14B-03_A001C001.mov'), 'utf8')).toBe('editorial put this here');

    await expect(dailies.start(settings({ destination: 'nowhere' }))).rejects.toThrow(/Pick where the dailies go/);
    await expect(dailies.start(settings({ include: 'scene', scenes: ['99'] }))).rejects.toThrow(/No takes/);
  });

  it('previews a clip as it is and through a look', async () => {
    const warm = db.importLut('Warm.cube', tintCube);
    const [clip] = db.previewClips(1);
    expect(clip).toMatchObject({ id: 'A001|A001C001', label: 'A001C001 · Sc 14 / B / T03', lutId: warm });
    const frames = await dailies.preview(clip!.id, warm);
    expect(frames.original).toMatch(/^data:image\/jpeg;base64,/);
    expect(frames.graded).toMatch(/^data:image\/jpeg;base64,/);
    expect(frames.graded).not.toBe(frames.original);
    expect((await dailies.preview(clip!.id, null)).graded).toBeNull();
  });
});
