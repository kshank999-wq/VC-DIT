import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProductionDb, type TransferRecord } from '../db/production-db';
import { writeReports } from '../media/reports';
import { cardFolder } from '../media/rules';
import { listSource, runTransfer, type LegPlan } from '../media/transfer';
import { parseScriptLog } from '../scriptlog/parse';
import type { RunCopy } from '../vfx/mirror';
import { VfxService } from '../vfx/vfx-service';

const wasm = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
const runCopy: RunCopy = async (plan) => {
  const result = await runTransfer(plan.sourceRoot, plan.files, plan.legs, plan.method);
  return { result, reports: await writeReports(result, plan.legs, plan.contexts, plan.allLegs) };
};

let base: string;
let db: ProductionDb;
let vfx: VfxService;
let legs: LegPlan[];
const request = { production: { name: 'HALCYON', code: 'HLC' }, day: { number: 1, date: '2026-10-07' } };

/** A card ingested to two destinations for real, and kept in the database as the media engine keeps it. */
const ingest = async () => {
  const card = join(base, 'cards', 'A015');
  await mkdir(join(card, 'A015R1AB'), { recursive: true });
  await writeFile(join(card, 'A015R1AB', 'A015C001_261007_R1AB.mxf'), 'take one');
  await writeFile(join(card, 'A015R1AB', 'A015C002_261007_R1AB.mxf'), Buffer.alloc(200_000, 9));
  await writeFile(join(card, 'A015R1AB', 'A015C002_261007_R1AB.xml'), '<clip/>');
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

const editorial = (leg: number, file = 'A015C002_261007_R1AB.mxf') => join(legs[leg]!.targetDir, 'A015R1AB', file);
const mirrorDir = (leg: number) => join(legs[leg]!.root, 'HALCYON', 'SHOOT_DAY_001_2026-10-07', 'VFX', 'SCENE_014', 'SETUP_B', 'T03_A015C002');

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vcdit-vfx-'));
  db = await ProductionDb.open(join(base, 'p.vcdit'), { wasm, create: { name: 'HALCYON', code: 'HLC' } });
  db.updateDay(1, { date: '2026-10-07' });
  vfx = new VfxService({ db: () => db, runCopy, tool: { name: 'VC DIT', version: 'test' }, changed: () => undefined });
  await ingest();
  db.importLog(
    1,
    'day1.csv',
    parseScriptLog('day1.csv', 'Scene,Setup,Take,Clip,VFX\n14,A,1,A015C001,\n14,B,3,A015C002,Sky replacement\n14,C,1,A016C001,Yes\n'),
  );
});

afterEach(async () => {
  await db.close();
  await rm(base, { recursive: true, force: true });
});

describe('VFX mirroring', () => {
  it("hard-links a flagged shot into VFX → Scene → Setup → Take on every destination, leaving the editorial copy as it was", async () => {
    const before = await readFile(editorial(0));
    expect(db.logView(1).vfx.map((shot) => [shot.clip, shot.matched, shot.locations.map((location) => location.state)])).toEqual([
      ['A015C002', true, ['pending', 'pending']],
      ['A016C001', false, []],
    ]);

    await vfx.run();
    for (const leg of [0, 1]) {
      const [original, mirror] = await Promise.all([stat(editorial(leg)), stat(join(mirrorDir(leg), 'A015R1AB', 'A015C002_261007_R1AB.mxf'))]);
      // The same data on disk: no space used, and nothing copied that could differ.
      expect(mirror.ino).toBe(original.ino);
      // Its sidecar comes along.
      expect((await stat(join(mirrorDir(leg), 'A015R1AB', 'A015C002_261007_R1AB.xml'))).isFile()).toBe(true);
    }
    expect(await readFile(editorial(0))).toEqual(before);
    const [shot] = db.logView(1).vfx;
    expect(shot!.locations).toEqual([
      expect.objectContaining({ destination: 'RAID', state: 'mirrored', method: 'Hard link', mirror: mirrorDir(0), editorial: join(legs[0]!.targetDir, 'A015R1AB') }),
      expect.objectContaining({ destination: 'SHUTTLE', state: 'mirrored', method: 'Hard link' }),
    ]);
    // Nothing left to do: running again changes nothing.
    expect(db.mirrorPlans(1, false)).toEqual([]);
  });

  it('writes a reference instead of media when the production mirrors by reference', async () => {
    db.updateProduction({ vfxMethod: 'Reference' });
    await vfx.run();
    expect((await readdir(mirrorDir(0))).sort()).toEqual(['VFX_REFERENCE.json', 'VFX_REFERENCE.txt']);
    const reference = JSON.parse(await readFile(join(mirrorDir(0), 'VFX_REFERENCE.json'), 'utf8'));
    expect(reference).toMatchObject({ schema: 'vcdit.vfx-reference/1', clip: 'A015C002', editorialFolder: '../../../../CAMERA_ORIGINALS/A015', checksumMethod: 'xxHash64' });
    expect(reference.files.map((file: { path: string }) => file.path)).toEqual(['A015R1AB/A015C002_261007_R1AB.mxf', 'A015R1AB/A015C002_261007_R1AB.xml']);
  });

  it('makes physical copies only when asked, verified against the card checksum', async () => {
    db.updateProduction({ vfxMethod: 'Physical copy' });
    await vfx.run();
    expect(db.logView(1).vfx[0]!.locations.map((location) => location.state)).toEqual(['pending', 'pending']);

    await vfx.run({ copies: true, retry: false });
    const copy = join(mirrorDir(0), 'A015R1AB', 'A015C002_261007_R1AB.mxf');
    expect((await stat(copy)).ino).not.toBe((await stat(editorial(0))).ino);
    expect(await readFile(copy)).toEqual(await readFile(editorial(0)));
    // A copy for a vendor carries its own ASC MHL.
    expect((await readdir(join(mirrorDir(0), 'ascmhl'))).some((name) => name.endsWith('.mhl'))).toBe(true);
    expect(db.logView(1).vfx[0]!.locations.map((location) => [location.method, location.state])).toEqual([
      ['Physical copy', 'mirrored'],
      ['Physical copy', 'mirrored'],
    ]);
  });

  it('refuses to copy an editorial copy that no longer matches the card, and says where', async () => {
    db.updateProduction({ vfxMethod: 'Physical copy' });
    await writeFile(editorial(1), Buffer.alloc(200_000, 7));
    await vfx.run({ copies: true, retry: false });
    const [raid, shuttle] = db.logView(1).vfx[0]!.locations;
    expect(raid).toMatchObject({ state: 'mirrored' });
    expect(shuttle).toMatchObject({ state: 'failed', error: expect.stringMatching(/no longer matches the card's checksum/) });
  });

  it('never replaces a different file already in the VFX folder, and fails a destination that is gone', async () => {
    await mkdir(join(mirrorDir(0), 'A015R1AB'), { recursive: true });
    await writeFile(join(mirrorDir(0), 'A015R1AB', 'A015C002_261007_R1AB.mxf'), 'something else');
    await rm(legs[1]!.root, { recursive: true });
    await vfx.run();
    const [raid, shuttle] = db.logView(1).vfx[0]!.locations;
    expect(raid).toMatchObject({ state: 'failed', error: expect.stringMatching(/different file is already in the VFX folder/) });
    expect(await readFile(join(mirrorDir(0), 'A015R1AB', 'A015C002_261007_R1AB.mxf'), 'utf8')).toBe('something else');
    expect(shuttle).toMatchObject({ state: 'failed', error: expect.stringMatching(/not available/) });
  });

  it('takes DIT tags for clips the log did not flag', async () => {
    db.tagVfx(1, 'a015c001', 'Monitor comp');
    expect(db.logView(1).vfx.find((shot) => shot.clip === 'A015C001')).toMatchObject({ flaggedBy: 'DIT tag', scene: '14', setup: 'A', take: '01', note: 'Monitor comp', matched: true });
    expect(() => db.tagVfx(1, 'A015C001', '')).toThrow(/already on the VFX list/);
    expect(() => db.tagVfx(1, 'B999C001', '')).toThrow(/No clip named B999C001/);
    await vfx.run();
    expect(db.logView(1).vfx.find((shot) => shot.clip === 'A015C001')!.locations.every((location) => location.state === 'mirrored')).toBe(true);
  });
});

describe('the VC VFX Prep handoff', () => {
  it('writes a package beside the mirrors on each destination, marks the shots sent, and sends nothing twice', async () => {
    expect(await vfx.sendToPrep()).toBe(0);
    await vfx.run();
    expect(await vfx.sendToPrep()).toBe(1);

    const vfxDir = join(legs[0]!.root, 'HALCYON', 'SHOOT_DAY_001_2026-10-07', 'VFX');
    const names = (await readdir(vfxDir)).filter((name) => name.startsWith('VC_VFX_PREP_'));
    expect(names.map((name) => name.replace(/\d{8}_\d{6}Z/, 'T')).sort()).toEqual(['VC_VFX_PREP_HLC_D001_T.csv', 'VC_VFX_PREP_HLC_D001_T.json']);
    const handoff = JSON.parse(await readFile(join(vfxDir, names.find((name) => name.endsWith('.json'))!), 'utf8'));
    expect(handoff).toMatchObject({
      schema: 'vcdit.vfx-handoff/1',
      production: { name: 'HALCYON', code: 'HLC' },
      day: { number: 1, date: '2026-10-07' },
      shots: [
        {
          scene: '14',
          setup: 'B',
          take: '03',
          clip: 'A015C002',
          note: 'Sky replacement',
          flaggedBy: 'Script sup.',
          mirror: { method: 'Hard link', folder: 'SCENE_014/SETUP_B/T03_A015C002' },
          editorialFolder: '../CAMERA_ORIGINALS/A015',
          checksumMethod: 'xxHash64',
        },
      ],
    });
    expect(handoff.shots[0].files[0]).toMatchObject({ path: 'A015R1AB/A015C002_261007_R1AB.mxf', size: 200_000, checksum: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(db.logView(1).vfx[0]!.sentAt).toEqual(expect.any(String));
    expect(await vfx.sendToPrep()).toBe(0);
  });
});
