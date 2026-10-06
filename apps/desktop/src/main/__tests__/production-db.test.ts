import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localDate } from '../../shared/project';
import { Library } from '../db/library';
import { ProductionDb, type TransferRecord } from '../db/production-db';

const wasm = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vcdit-db-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const transfer = (patch: Partial<TransferRecord> = {}): TransferRecord => ({
  id: 'A015',
  day: 1,
  card: 'A015',
  label: 'ARRI · MXF',
  sourceRoot: '/Volumes/A015',
  sound: false,
  checksum: 'xxHash64',
  startedAt: '2026-10-06T18:00:00.000Z',
  finishedAt: '2026-10-06T18:10:00.000Z',
  files: [
    { path: 'A015R1AB/A015C001_261005_R1AB.mxf', size: 100, mtimeMs: 1_700_000_000_000, hash: 'aaaaaaaaaaaaaaaa', hashedAt: '2026-10-06T18:01:00.000Z' },
    { path: 'A015R1AB/A015C002_261005_R1AB.mxf', size: 200, mtimeMs: 1_700_000_000_500, hash: 'bbbbbbbbbbbbbbbb', hashedAt: '2026-10-06T18:02:00.000Z' },
  ],
  destinations: [
    {
      id: '/Volumes/RAID',
      name: 'RAID',
      root: '/Volumes/RAID',
      targetDir: '/Volumes/RAID/P/SHOOT_DAY_001/CAMERA_ORIGINALS/A015',
      reportsDir: '/Volumes/RAID/P/SHOOT_DAY_001/REPORTS/ingest_verification',
      error: null,
      outcomes: { 'A015R1AB/A015C001_261005_R1AB.mxf': { state: 'verified' }, 'A015R1AB/A015C002_261005_R1AB.mxf': { state: 'already-there' } },
    },
    {
      id: 'folder:/nas',
      name: 'nas',
      root: '/nas',
      targetDir: '/nas/P/SHOOT_DAY_001/CAMERA_ORIGINALS/A015',
      reportsDir: '/nas/P/SHOOT_DAY_001/REPORTS/ingest_verification',
      error: null,
      outcomes: {
        'A015R1AB/A015C001_261005_R1AB.mxf': { state: 'verified' },
        'A015R1AB/A015C002_261005_R1AB.mxf': { state: 'failed', error: 'Checksum mismatch: the copy does not match the card.' },
      },
    },
  ],
  ...patch,
});

describe('a production database', () => {
  it('starts a new production with day one dated today, and keeps every change in its file', async () => {
    const file = join(dir, 'p.vcdit');
    const db = await ProductionDb.open(file, { wasm, create: { name: 'HALCYON', code: 'HLC' }, saveDelayMs: 5 });
    expect(db.production()).toMatchObject({ name: 'HALCYON', code: 'HLC', checksum: 'xxHash64', devices: [] });
    expect(db.days()).toEqual([{ number: 1, date: localDate(), locations: '', operator: { name: '', initials: '' } }]);

    db.updateProduction({ frameRate: '25 fps', devices: [{ slot: 'A', name: 'ALEXA 35', format: 'ARRIRAW' }] });
    db.updateDay(1, { locations: 'Hangar', operator: { name: 'Morgan Reyes', initials: 'MR' } });
    expect(db.addScene(1, { id: '14a', description: 'INT. HANGAR – DAY' })).toBe(true);
    expect(db.addScene(1, { id: '14A' })).toBe(false);
    db.addScene(1, { id: '21' });
    db.updateScene(1, '14A', { status: 'Shot', notes: 'Circle T3' });
    db.removeScene(1, '21');
    await db.close();

    expect((await readdir(dir)).sort()).toEqual(['p.vcdit']);
    const again = await ProductionDb.open(file, { wasm });
    expect(again.production()).toMatchObject({ name: 'HALCYON', frameRate: '25 fps', devices: [{ slot: 'A', name: 'ALEXA 35', format: 'ARRIRAW' }] });
    expect(again.currentDay()).toMatchObject({ number: 1, locations: 'Hangar', operator: { name: 'Morgan Reyes', initials: 'MR' } });
    expect(again.scenes(1)).toEqual([{ id: '14A', description: 'INT. HANGAR – DAY', status: 'Shot', notes: 'Circle T3', look: '' }]);
    // Opening kept the previous version alongside.
    expect((await readdir(dir)).sort()).toEqual(['p.vcdit', 'p.vcdit.bak']);
    await again.close();
  });

  it('adds days in order, each opened as it is made, with the operator carried over', async () => {
    const db = await ProductionDb.open(join(dir, 'p.vcdit'), { wasm, create: {} });
    db.updateDay(1, { date: '2099-01-01', operator: { name: 'Morgan Reyes', initials: 'MR' } });
    const two = db.addDay();
    expect(two).toMatchObject({ number: 2, date: '2099-01-02', operator: { initials: 'MR' } });
    expect(db.currentDay().number).toBe(2);
    db.openDay(1);
    expect(db.currentDay().number).toBe(1);
    expect(() => db.openDay(9)).toThrow(/No such shoot day/);
    await db.close();
  });

  it('keeps transfers with every clip and copy, replaces one when it is saved again, and finds clips by name', async () => {
    const db = await ProductionDb.open(join(dir, 'p.vcdit'), { wasm, create: {} });
    db.saveTransfer(transfer({ finishedAt: null }));
    db.saveTransfer(transfer());
    db.saveTransfer(transfer({ id: '888_D01', card: '888_D01', sound: true, startedAt: '2026-10-06T18:30:00.000Z', files: [{ path: 'T01.WAV', size: 5, mtimeMs: 1, hash: null, hashedAt: null }], destinations: [] }));
    const [camera, sound] = db.transfers(1);
    expect(camera).toEqual(transfer());
    expect(sound).toMatchObject({ id: '888_D01', sound: true });
    expect(db.transfers(2)).toEqual([]);
    expect(db.findClips('A015C002_261005_R1AB.mxf')).toEqual([
      { day: 1, card: 'A015', path: 'A015R1AB/A015C002_261005_R1AB.mxf', checksum: 'bbbbbbbbbbbbbbbb', verifiedCopies: 1 },
    ]);
    await db.close();
  });

  it('refuses a file that is not a production, and one from a newer version of the app', async () => {
    const junk = join(dir, 'junk.vcdit');
    await writeFile(junk, 'not sqlite at all, just text that is long enough to not look like an empty file');
    await expect(ProductionDb.open(junk, { wasm })).rejects.toThrow(/not a VC DIT production/);

    const SQL = await initSqlJs({ wasmBinary: (await readFile(wasm)).buffer as ArrayBuffer });
    const other = new SQL.Database();
    other.exec('create table notes (a); pragma user_version = 1;');
    await writeFile(join(dir, 'other.vcdit'), other.export());
    await expect(ProductionDb.open(join(dir, 'other.vcdit'), { wasm })).rejects.toThrow(/not a VC DIT production/);

    const db = await ProductionDb.open(join(dir, 'p.vcdit'), { wasm, create: {} });
    await db.close();
    const future = new SQL.Database(await readFile(join(dir, 'p.vcdit')));
    future.exec('pragma user_version = 99');
    await writeFile(join(dir, 'p.vcdit'), future.export());
    await expect(ProductionDb.open(join(dir, 'p.vcdit'), { wasm })).rejects.toThrow(/newer VC DIT/);
  });

  it('saves a copy that opens as the same production', async () => {
    const db = await ProductionDb.open(join(dir, 'p.vcdit'), { wasm, create: { name: 'NIGHTJAR' } });
    db.addScene(1, { id: '1' });
    await db.saveCopy(join(dir, 'copy.vcdit'));
    await db.close();
    const copy = await ProductionDb.open(join(dir, 'copy.vcdit'), { wasm });
    expect(copy.production().name).toBe('NIGHTJAR');
    expect(copy.scenes(1).map((scene) => scene.id)).toEqual(['1']);
    await copy.close();
  });
});

describe('the library of productions', () => {
  it('starts a first production, reopens it next time, and switches between productions', async () => {
    const first = new Library({ dir, wasm });
    const db = await first.start();
    db.updateProduction({ name: 'HALCYON' });
    await first.rememberAndSave();
    const halcyon = db.file;
    expect(halcyon.endsWith('.vcdit')).toBe(true);
    await first.close();

    const second = new Library({ dir, wasm });
    expect((await second.start()).file).toBe(halcyon);
    expect(second.state().production.name).toBe('HALCYON');

    const next = await second.create({ name: 'NIGHTJAR' });
    expect(next.file).not.toBe(halcyon);
    expect(second.state().recent.map((item) => item.name)).toEqual(['NIGHTJAR', 'HALCYON']);
    await second.open(halcyon);
    expect(second.state().production.name).toBe('HALCYON');
    expect(second.state().recent[0]!.name).toBe('HALCYON');
    await second.close();
  });

  it('starts a fresh production when the last one has gone missing', async () => {
    const library = new Library({ dir, wasm });
    const gone = (await library.start()).file;
    await library.close();
    await rm(gone);
    const again = new Library({ dir, wasm });
    expect((await again.start()).file).not.toBe(gone);
    await again.close();
  });
});
