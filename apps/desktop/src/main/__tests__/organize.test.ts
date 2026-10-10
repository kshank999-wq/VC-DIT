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
