import { mkdir, mkdtemp, readdir, readFile, rm, truncate, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProductionDb, type TransferRecord } from '../db/production-db';
import { cardFolder } from '../media/rules';
import { sealDrive } from '../media/seal';
import { listSource, runTransfer, type LegPlan } from '../media/transfer';

const wasm = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
const request = { production: { name: 'HALCYON', code: 'HLC' }, day: { number: 1, date: '2026-10-07' } };
const tool = { name: 'VC DIT', version: 'test' };

let base: string;
let db: ProductionDb;
let legs: LegPlan[];

/** A card copied for real to the RAID and a shuttle, kept in the database as the media engine keeps it. */
const ingest = async (finishedAt?: string) => {
  const card = join(base, 'cards', 'A015');
  await mkdir(join(card, 'A015R1AB'), { recursive: true });
  await writeFile(join(card, 'A015R1AB', 'A015C001.mxf'), 'take one');
  await writeFile(join(card, 'A015R1AB', 'A015C002.mxf'), Buffer.alloc(50_000, 7));
  legs = ['RAID', 'SHUTTLE_01'].map((name) => {
    const root = join(base, name);
    return { id: root, name, root, targetDir: cardFolder(root, request, false, 'A015') };
  });
  for (const leg of legs) await mkdir(leg.root, { recursive: true });
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
    finishedAt: finishedAt ?? result.finishedAt,
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

const shuttle = () => legs[1]!;
const onShuttle = (file: string) => join(shuttle().targetDir, 'A015R1AB', file);
const seal = (verify: boolean, root = shuttle().root, name = 'SHUTTLE_01') =>
  sealDrive({ root, name, production: 'HALCYON', expected: db.sealExpectations(root, name), verify, tool });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vcdit-seal-'));
  db = await ProductionDb.open(join(base, 'p.vcdit'), { wasm, create: { name: 'HALCYON', code: 'HLC' } });
  db.updateDay(1, { date: '2026-10-07' });
  await ingest();
});
afterEach(async () => {
  await db.close();
  await rm(base, { recursive: true, force: true });
});

describe('sealing a drive', () => {
  it('knows every file copied to the drive, relative to it, with its checksum', () => {
    const expected = db.sealExpectations(shuttle().root, 'SHUTTLE_01');
    expect(expected.map((file) => [file.dir, file.path, file.method])).toEqual([
      ['HALCYON/SHOOT_DAY_001_2026-10-07/CAMERA_ORIGINALS/A015', 'A015R1AB/A015C001.mxf', 'xxHash64'],
      ['HALCYON/SHOOT_DAY_001_2026-10-07/CAMERA_ORIGINALS/A015', 'A015R1AB/A015C002.mxf', 'xxHash64'],
    ]);
    expect(expected.every((file) => /^[0-9a-f]{16}$/.test(file.hash ?? ''))).toBe(true);
    // Mounted somewhere else on another day (a new drive letter): found by its name.
    expect(db.sealExpectations('/Volumes/elsewhere', 'SHUTTLE_01')).toHaveLength(2);
    expect(db.sealExpectations('/Volumes/elsewhere', 'SOME_OTHER')).toHaveLength(0);
  });

  it('reads every file back, then writes a manifest that can itself be checked', async () => {
    const outcome = await seal(true);
    expect(outcome).toMatchObject({ ok: true, files: 2, bytes: 50_008, verified: true, missing: [], changed: [], added: [], unhashed: 0 });
    const folder = join(shuttle().root, 'HALCYON', 'SEALS');
    const names = (await readdir(folder)).sort();
    expect(names).toHaveLength(2);
    const csv = await readFile(join(folder, names[0]!), 'utf8');
    expect(csv.split('\n')[0]).toBe('Day,Card,Path,Size,Method,Checksum,Checked');
    expect(csv).toContain('A015R1AB/A015C002.mxf,50000,xxHash64,');
    expect(csv).toContain(',read back');
    const summary = JSON.parse(await readFile(join(folder, names[1]!), 'utf8'));
    expect(summary).toMatchObject({ schema: 'vc-dit.seal/1', drive: 'SHUTTLE_01', files: 2 });
    expect(summary.manifest.sha256).toBe(createHash('sha256').update(csv).digest('hex'));
    expect(outcome.manifest).toBe(join(folder, names[0]!));
  });

  it('refuses a drive with a file missing or changed, and writes nothing', async () => {
    await unlink(onShuttle('A015C001.mxf'));
    const missing = await seal(false);
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual(['HALCYON/SHOOT_DAY_001_2026-10-07/CAMERA_ORIGINALS/A015/A015R1AB/A015C001.mxf']);
    expect(missing.problems[0]).toMatch(/1 file copied here is not on the drive now/);
    expect(missing.manifest).toBeNull();
    await expect(readdir(join(shuttle().root, 'HALCYON', 'SEALS'))).rejects.toThrow();

    // Same size, different bytes: only reading it back finds it.
    await writeFile(onShuttle('A015C001.mxf'), 'take one');
    await writeFile(onShuttle('A015C002.mxf'), Buffer.alloc(50_000, 8));
    expect((await seal(false)).ok).toBe(true);
    const changed = await seal(true);
    expect(changed.ok).toBe(false);
    expect(changed.changed[0]).toMatchObject({ path: expect.stringContaining('A015C002.mxf'), why: expect.stringMatching(/xxHash64 does not match/) });

    await truncate(onShuttle('A015C002.mxf'), 10);
    expect((await seal(false)).changed[0]!.why).toMatch(/10 bytes now, 50,000 when copied/);
  });

  it('notes files in the card folders the production does not know, without refusing', async () => {
    await writeFile(onShuttle('A015C099.mxf'), 'not ours');
    const outcome = await seal(false);
    expect(outcome.ok).toBe(true);
    expect(outcome.added).toEqual(['HALCYON/SHOOT_DAY_001_2026-10-07/CAMERA_ORIGINALS/A015/A015R1AB/A015C099.mxf']);
  });

  it('has nothing to seal on a drive nothing was copied to', async () => {
    const empty = join(base, 'EMPTY');
    await mkdir(empty);
    const outcome = await seal(true, empty, 'EMPTY');
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]).toMatch(/Nothing has been copied to EMPTY/);
  });

  it('remembers the last seal, and says when the drive was copied to after it', async () => {
    const outcome = await seal(true);
    db.recordSeal({ root: outcome.root, name: outcome.name, sealedAt: outcome.checkedAt, files: outcome.files, bytes: outcome.bytes, verified: true, manifest: outcome.manifest });
    expect(db.seals()).toEqual([expect.objectContaining({ name: 'SHUTTLE_01', files: 2, verified: true, stale: false })]);
    // Another card to it, finishing after the seal.
    await ingest(new Date(Date.now() + 60_000).toISOString());
    expect(db.seals()[0]!.stale).toBe(true);
  });
});
