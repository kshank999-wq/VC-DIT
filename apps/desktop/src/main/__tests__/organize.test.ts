import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyNaming, parseNaming } from '../../shared/project';
import { ProductionDb, type TransferRecord } from '../db/production-db';
import { placeViews } from '../delivery/delivery-service';
import { cardFolder } from '../media/rules';
import { listSource, runTransfer, type LegPlan } from '../media/transfer';
import { OrganizeService } from '../organize/organize-service';
import { parseScriptLog } from '../scriptlog/parse';

const wasm = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
const request = { production: { name: 'HALCYON', code: 'HLC' }, day: { number: 1, date: '2026-10-07' } };

let base: string;
let db: ProductionDb;
let organizer: OrganizeService;
let legs: LegPlan[];

/** A card ingested to two destinations for real, kept in the database as the media engine keeps it. */
const ingest = async () => {
  const card = join(base, 'cards', 'A015');
  await mkdir(join(card, 'A015R1AB'), { recursive: true });
  await writeFile(join(card, 'A015R1AB', 'A015C001_261007_R1AB.mxf'), 'take one');
  await writeFile(join(card, 'A015R1AB', 'A015C002_261007_R1AB.mxf'), Buffer.alloc(20_000, 9));
  await writeFile(join(card, 'A015R1AB', 'A015C002_261007_R1AB.xml'), '<clip/>');
  await writeFile(join(card, 'A015R1AB', 'A015C003_261007_R1AB.mxf'), 'wild track');
  legs = [];
  for (const name of ['RAID', 'SHUTTLE']) {
    const root = join(base, name);
    await mkdir(root, { recursive: true });
    legs.push({ id: root, name, root, targetDir: cardFolder(root, request, false, 'A015') });
  }
  const { files } = await listSource(card);
  const result = await runTransfer(card, files, legs, 'xxHash64');
  const record: TransferRecord = {
    id: 'A015',
    day: 1,
    card: 'A015',
    label: 'ARRI · MXF',
    sourceRoot: card,
    sound: false,
    checksum: 'xxHash64',
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    files: result.files.map((file) => ({ path: file.path, size: file.size, mtimeMs: file.mtimeMs, hash: file.sourceHash, hashedAt: file.hashedAt })),
    destinations: legs.map((leg) => ({
      id: leg.id,
      name: leg.name,
      root: leg.root,
      targetDir: leg.targetDir,
      reportsDir: join(leg.root, 'reports'),
      error: null,
      outcomes: Object.fromEntries(result.files.map((file) => [file.path, file.legs[leg.id]!])),
    })),
  };
  db.saveTransfer(record);
};

const day = (leg: number) => join(legs[leg]!.root, 'HALCYON', 'SHOOT_DAY_001_2026-10-07');
const scenes = (leg: number, ...path: string[]) => join(day(leg), 'CAMERA_ORIGINALS', '_BY_SCENE', ...path);
const card = (leg: number, file: string) => join(legs[leg]!.targetDir, 'A015R1AB', file);
const same = async (a: string, b: string) => {
  const [x, y] = await Promise.all([stat(a), stat(b)]);
  return x.dev === y.dev && x.ino === y.ino;
};
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const LOG = 'Scene,Setup,Take,Clip,Circle\n14,A,1,A015C001,\n14,B,3,A015C002,Y\n';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vcdit-organize-'));
  db = await ProductionDb.open(join(base, 'p.vcdit'), { wasm, create: { name: 'HALCYON', code: 'HLC' } });
  db.updateDay(1, { date: '2026-10-07' });
  organizer = new OrganizeService({ db: () => db, changed: () => undefined });
  await ingest();
  db.importLog(1, 'day1.csv', parseScriptLog('day1.csv', LOG));
});
afterEach(async () => {
  await db.close();
  await rm(base, { recursive: true, force: true });
});

describe('the naming template', () => {
  it('names a take folder from its fields, and reads a typed template back into tokens', () => {
    const tokens = parseNaming('{PROD}_D{DAY}_SC{SCENE}{SETUP}_T{TAKE}_{CAM}{REEL}');
    expect(tokens).toEqual(['{PROD}', '_', 'D', '{DAY}', '_', 'SC', '{SCENE}', '{SETUP}', '_', 'T', '{TAKE}', '_', '{CAM}', '{REEL}']);
    expect(applyNaming(tokens, { prod: 'HLC', day: 14, scene: '21', setup: 'B', take: '4', clip: 'A015C002' })).toBe('HLC_D014_SC21B_T04_A015');
    // An empty field never leaves a doubled or dangling separator.
    expect(applyNaming(parseNaming('{PROD}_{SETUP}_T{TAKE}_'), { prod: 'HLC', day: 1, scene: '1', setup: '', take: '2', clip: 'X' })).toBe('HLC_T02');
  });
});

describe('the scene folders', () => {
  it('links every verified clip under its scene, setup and take on every destination, and circle takes under the selects', async () => {
    await organizer.run();
    for (const leg of [0, 1]) {
      const take1 = scenes(leg, 'SCENE_014', 'SETUP_A', 'HLC_D001_SC14A_T01_A015', 'A015R1AB', 'A015C001_261007_R1AB.mxf');
      expect(await same(take1, card(leg, 'A015C001_261007_R1AB.mxf'))).toBe(true);
      // A clip's sidecar goes with it.
      const take3 = scenes(leg, 'SCENE_014', 'SETUP_B', 'HLC_D001_SC14B_T03_A015', 'A015R1AB');
      expect((await readdir(take3)).sort()).toEqual(['A015C002_261007_R1AB.mxf', 'A015C002_261007_R1AB.xml']);
      // A clip the log does not name waits under UNMATCHED, by card.
      expect(await same(scenes(leg, 'UNMATCHED', 'A015', 'A015C003', 'A015R1AB', 'A015C003_261007_R1AB.mxf'), card(leg, 'A015C003_261007_R1AB.mxf'))).toBe(true);
      const selects = join(day(leg), 'SELECTS_CIRCLE_TAKES', 'SCENE_014');
      expect(await readdir(selects)).toEqual(['SETUP_B']);
      expect(await same(join(selects, 'SETUP_B', 'HLC_D001_SC14B_T03_A015', 'A015R1AB', 'A015C002_261007_R1AB.mxf'), card(leg, 'A015C002_261007_R1AB.mxf'))).toBe(true);
    }
    expect(organizer.view()).toMatchObject({ placed: 6, references: 0, failed: 0, pending: 0 });
    expect(organizer.view().folders.map((folder) => folder.destination).sort()).toEqual(['RAID', 'SHUTTLE']);
    // The cards are exactly as ingested.
    expect((await readdir(join(legs[0]!.targetDir, 'A015R1AB'))).length).toBe(4);
  });

  it('follows the log: a corrected take moves, an uncircled take leaves the selects, and only its own links are removed', async () => {
    await organizer.run();
    // Someone left a file of their own in the old take folder.
    const old = scenes(0, 'SCENE_014', 'SETUP_A', 'HLC_D001_SC14A_T01_A015');
    await writeFile(join(old, 'notes.txt'), 'mine');

    db.importLog(1, 'day1-v2.csv', parseScriptLog('day1-v2.csv', 'Scene,Setup,Take,Clip,Circle\n21,A,2,A015C001,\n14,B,3,A015C002,\n'));
    await organizer.run();

    expect(await same(scenes(1, 'SCENE_021', 'SETUP_A', 'HLC_D001_SC21A_T02_A015', 'A015R1AB', 'A015C001_261007_R1AB.mxf'), card(1, 'A015C001_261007_R1AB.mxf'))).toBe(true);
    // Gone where nothing else was; kept, with the stranger's file, where something was.
    expect(await exists(scenes(1, 'SCENE_014', 'SETUP_A'))).toBe(false);
    expect(await readdir(old)).toEqual(['notes.txt']);
    expect(await exists(join(day(0), 'SELECTS_CIRCLE_TAKES', 'SCENE_014'))).toBe(false);
    // The card copies are untouched, and no longer linked from anywhere else.
    expect(await readFile(card(0, 'A015C001_261007_R1AB.mxf'), 'utf8')).toBe('take one');
    expect((await stat(card(1, 'A015C001_261007_R1AB.mxf'))).nlink).toBe(2);
  });

  it('renames the take folders when the template changes', async () => {
    await organizer.run();
    db.updateProduction({ namingTokens: parseNaming('SC{SCENE}{SETUP}_T{TAKE}_{CLIP}') });
    await organizer.run();
    expect(await readdir(scenes(0, 'SCENE_014', 'SETUP_B'))).toEqual(['SC14B_T03_A015C002']);
    expect(organizer.view()).toMatchObject({ placed: 6, failed: 0 });
  });

  it('never replaces a different file already where a link would go', async () => {
    const blocked = scenes(1, 'SCENE_014', 'SETUP_A', 'HLC_D001_SC14A_T01_A015', 'A015R1AB');
    await mkdir(blocked, { recursive: true });
    await writeFile(join(blocked, 'A015C001_261007_R1AB.mxf'), 'something else');
    await organizer.run();
    expect(organizer.view()).toMatchObject({ placed: 5, failed: 1 });
    expect(organizer.view().problems[0]).toMatchObject({ clip: 'A015C001', destination: 'SHUTTLE', error: expect.stringMatching(/different file is already in the scene folder/) });
    expect(await readFile(join(blocked, 'A015C001_261007_R1AB.mxf'), 'utf8')).toBe('something else');
  });

  it('is laid out again on a delivery destination, as links to the cards it received', async () => {
    const other = join(base, 'EDIT_SHUTTLE', 'HALCYON', 'SHOOT_DAY_001_2026-10-07');
    await cp(join(day(0), 'CAMERA_ORIGINALS', 'A015'), join(other, 'CAMERA_ORIGINALS', 'A015'), { recursive: true });
    expect(await placeViews(db, 1, other)).toBe(4);
    expect(
      await same(
        join(other, 'SELECTS_CIRCLE_TAKES', 'SCENE_014', 'SETUP_B', 'HLC_D001_SC14B_T03_A015', 'A015R1AB', 'A015C002_261007_R1AB.mxf'),
        join(other, 'CAMERA_ORIGINALS', 'A015', 'A015R1AB', 'A015C002_261007_R1AB.mxf'),
      ),
    ).toBe(true);
  });
});

describe('where clips go: the log, the camera report, the sound slate and the DIT', () => {
  const where = (clip: string) => db.takesView(1).clips.find((item) => item.clip === clip)!;

  it('places a clip the log leaves out from the camera report, on every destination', async () => {
    db.setCameraReport(1, 'A015', [{ card: 'A015', clip: 'C003', scene: '14', setup: 'C', take: '1', circle: false, lens: '50mm', notes: '' }]);
    expect(where('A015C003')).toMatchObject({ scene: '14', setup: 'C', take: '1', by: 'report', conflict: false });
    await organizer.run();
    for (const leg of [0, 1]) {
      expect(await same(scenes(leg, 'SCENE_014', 'SETUP_C', 'HLC_D001_SC14C_T01_A015', 'A015R1AB', 'A015C003_261007_R1AB.mxf'), card(leg, 'A015C003_261007_R1AB.mxf'))).toBe(true);
      expect(await exists(scenes(leg, 'UNMATCHED'))).toBe(false);
    }
    // Agreeing with the log changes nothing: still the log's word.
    db.setCameraReport(1, 'A015', [
      { card: 'A015', clip: 'C001', scene: '14', setup: 'A', take: '1', circle: false, lens: '', notes: '' },
      { card: 'A015', clip: 'C003', scene: '14', setup: 'C', take: '1', circle: false, lens: '', notes: '' },
    ]);
    expect(where('A015C001')).toMatchObject({ by: 'log', conflict: false });
    expect(where('A015C001').claims.map((claim) => claim.source)).toEqual(['log', 'report']);
    // The Scene Organizer shows the report's take too.
    const sc14 = db.logView(1).scenes.find((scene) => scene.id === '14')!;
    expect(sc14.setups.map((setup) => setup.id)).toEqual(['A', 'B', 'C']);
  });

  it('holds a clip back when the log and the report disagree, until Match Review decides', async () => {
    db.setCameraReport(1, 'A015', [{ card: 'A015', clip: 'C002', scene: '14', setup: 'B', take: '4', circle: true, lens: '', notes: '' }]);
    expect(where('A015C002')).toMatchObject({ scene: '', by: null, conflict: true });
    const review = db.logView(1).matches.find((match) => match.kind === 'sources')!;
    expect(review).toMatchObject({ id: 'sources:A015|A015C002', resolution: null });
    expect(review.candidates.map((candidate) => candidate.clip)).toEqual(['Sc 14 / B / T03', 'Sc 14 / B / T04']);
    await organizer.run();
    expect(await exists(scenes(0, 'UNMATCHED', 'A015', 'A015C002'))).toBe(true);

    db.resolveMatch(1, review.id, 'Sc 14 / B / T04');
    expect(where('A015C002')).toMatchObject({ scene: '14', setup: 'B', take: '4', by: 'manual', conflict: false });
    expect(db.logView(1).matches.find((match) => match.kind === 'sources')!.resolution).toEqual({ kind: 'matched', clip: 'Sc 14 / B / T04' });
    await organizer.run();
    expect(await same(scenes(1, 'SCENE_014', 'SETUP_B', 'HLC_D001_SC14B_T04_A015', 'A015R1AB', 'A015C002_261007_R1AB.mxf'), card(1, 'A015C002_261007_R1AB.mxf'))).toBe(true);
    expect(await exists(scenes(1, 'UNMATCHED', 'A015', 'A015C002'))).toBe(false);
  });

  it('takes the DIT\'s own word over every source, and gives it back', async () => {
    db.assignClips(1, [{ card: 'A015', clip: 'A015C001' }], { scene: '30', setup: 'a', take: '02', circle: true });
    expect(where('A015C001')).toMatchObject({ scene: '30', setup: 'A', take: '2', circle: true, by: 'manual' });
    await organizer.run();
    expect(await exists(scenes(0, 'SCENE_030', 'SETUP_A', 'HLC_D001_SC30A_T02_A015'))).toBe(true);
    expect(await exists(join(day(0), 'SELECTS_CIRCLE_TAKES', 'SCENE_030', 'SETUP_A'))).toBe(true);
    db.assignClips(1, [{ card: 'A015', clip: 'A015C001' }], null);
    expect(where('A015C001')).toMatchObject({ scene: '14', setup: 'A', by: 'log' });
  });

  it('takes the slate the sound recorder wrote, through the sync', async () => {
    db.saveTransfer({
      id: 'S014',
      day: 1,
      card: 'S014',
      label: 'Sound',
      sourceRoot: join(base, 'cards', 'S014'),
      sound: true,
      checksum: 'xxHash64',
      startedAt: '2026-10-07T10:00:00.000Z',
      finishedAt: '2026-10-07T10:01:00.000Z',
      files: [{ path: '14C-01.wav', size: 10, mtimeMs: 1, hash: 'aa', hashedAt: '2026-10-07T10:00:30.000Z' }],
      destinations: [],
    });
    db.saveMeta(1, 'S014', '14C-01.wav', {
      ok: true,
      meta: { kind: 'sound', format: 'WAV', tc: null, rate: null, durationSec: 10, soundStartSec: 0, sampleRate: 48000, channels: 2, hasAudio: true, ixml: { scene: '14C', take: '01', tape: 'S014', rate: '', tracks: [] } },
    });
    db.saveSync(1, { card: 'A015', clipKey: 'A015C003', soundCard: 'S014', soundKey: '14C-01', method: 'Timecode', alignFrames: 0, baseFrames: 0, fps: 25, confidence: 1, why: '', accepted: true, decided: 'auto', barsPicture: [], barsSound: [] });
    expect(where('A015C003')).toMatchObject({ scene: '14', setup: 'C', take: '1', by: 'sound' });
    expect(where('A015C003').claims[0]).toMatchObject({ source: 'sound', from: 'Sound file 14C-01' });
  });

  it('reads a camera report file, and checks it against the card', () => {
    const csv = 'Roll,Clip,Scene,Setup,Take,Circle,Lens,Notes\nA015,C001,14,A,1,,35mm,\nA015,C009,14,A,2,Y,35mm,\n,C010,14,A,3,,,no roll\n';
    const result = db.importCameraReport(1, parseScriptLog('report.csv', csv).entries);
    expect(result).toMatchObject({ cards: ['A015'], rows: 2 });
    expect(result.skipped).toEqual(['Line 4: no card or roll — skipped.']);
    const view = db.takesView(1);
    expect(view.report.map((row) => [row.clip, row.take, row.circle, row.source])).toEqual([
      ['C001', '1', false, 'csv'],
      ['C009', '2', true, 'csv'],
    ]);
    expect(view.reportProblems).toEqual([
      'A015: the report names A015C009 (Sc 14A T2), but it is not on the card.',
      'A015: 2 clips on the card are not in the report (A015C002, A015C003).',
    ]);
  });
});

describe('reading a slate', () => {
  it('splits a sound recorder\'s slate by the day\'s scene list', async () => {
    const { splitSlate, reportClipKey, resolveAssignment } = await import('../organize/assign');
    expect(splitSlate('14B', new Set(['14']))).toEqual({ scene: '14', setup: 'B' });
    expect(splitSlate('14A', new Set(['14A']))).toEqual({ scene: '14A', setup: '' });
    expect(splitSlate('14AB', new Set(['14A']))).toEqual({ scene: '14A', setup: 'B' });
    expect(reportClipKey('A015', 'C2')).toBe('A015C002');
    expect(reportClipKey('A015', '7')).toBe('A015C007');
    expect(reportClipKey('A015', 'B010C003')).toBe('B010C003');
    // "14" + "B" and "14B" agree; take "03" and "3" agree.
    const agree = resolveAssignment('A015', 'A015C001', [
      { source: 'log', scene: '14', setup: 'B', take: '03', circle: false, from: '' },
      { source: 'sound', scene: '14B', setup: '', take: '3', circle: false, from: '' },
    ]);
    expect(agree).toMatchObject({ conflict: false, by: 'log', slate: { scene: '14', setup: 'B', take: '3' } });
  });
});
