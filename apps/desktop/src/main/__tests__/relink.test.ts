import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProductionDb, type TransferRecord } from '../db/production-db';
import { findMoved } from '../media/relink';
import { cardFolder } from '../media/rules';
import { listSource, runTransfer, type LegPlan } from '../media/transfer';

const wasm = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
const request = { production: { name: 'HALCYON', code: 'HLC' }, day: { number: 1, date: '2026-10-07' } };

let base: string;
let db: ProductionDb;
let raid: string;

/** A card copied for real to a RAID, kept in the database as the media engine keeps it (the leg known by the RAID's mount path). */
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vcdit-relink-'));
  db = await ProductionDb.open(join(base, 'p.vcdit'), { wasm, create: { name: 'HALCYON', code: 'HLC' } });
  db.updateDay(1, { date: '2026-10-07' });
  const card = join(base, 'cards', 'A015');
  await mkdir(join(card, 'A015R1AB'), { recursive: true });
  await writeFile(join(card, 'A015R1AB', 'A015C001.mxf'), 'take one');
  await writeFile(join(card, 'A015R1AB', 'A015C002.mxf'), Buffer.alloc(30_000, 4));
  raid = join(base, 'RAID');
  await mkdir(raid);
  const legs: LegPlan[] = [{ id: raid, name: 'RAID', root: raid, targetDir: cardFolder(raid, request, false, 'A015') }];
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
      reportsDir: join(leg.root, 'HALCYON', 'SHOOT_DAY_001_2026-10-07', 'REPORTS', 'ingest_verification'),
      error: null,
      outcomes: Object.fromEntries(result.files.map((file) => [file.path, file.legs[leg.id]!])),
    })),
  };
  db.saveTransfer(record);
});
afterEach(async () => {
  await db.close();
  await rm(base, { recursive: true, force: true });
});

const dirOf = (root: string) => join(root, 'HALCYON', 'SHOOT_DAY_001_2026-10-07', 'CAMERA_ORIGINALS', 'A015');

describe('relinking copies that moved', () => {
  it('finds a drive back under a new name, proves the copy, and points the production at it', async () => {
    // Mounted again as "RAID 1".
    const moved = join(base, 'RAID 1');
    await rename(raid, moved);
    expect(db.copyLocations().map((copy) => [copy.name, copy.root, copy.card])).toEqual([['RAID', raid, 'A015']]);
    const legs = db.relinkLegs('RAID', raid);
    expect(legs[0]!.files.map((file) => file.path)).toEqual(['A015R1AB/A015C001.mxf', 'A015R1AB/A015C002.mxf']);

    const { found, missing } = await findMoved(legs, moved);
    expect(missing).toEqual([]);
    expect(found.map((item) => [item.root, item.targetDir])).toEqual([[moved, dirOf(moved)]]);
    db.relink(found);
    const destination = db.transfers(1)[0]!.destinations[0]!;
    // Known by the drive's new place, every file's copy with it.
    expect(destination).toMatchObject({ id: moved, root: moved, targetDir: dirOf(moved), reportsDir: join(moved, 'HALCYON', 'SHOOT_DAY_001_2026-10-07', 'REPORTS', 'ingest_verification') });
    expect(Object.values(destination.outcomes)).toEqual([{ state: 'verified' }, { state: 'verified' }]);
    expect(db.sealExpectations(moved, 'RAID')).toHaveLength(2);
  });

  it('searches for the card folder when it was moved deeper, too', async () => {
    const place = join(base, 'NAS');
    await mkdir(join(place, 'archive', '2026'), { recursive: true });
    await rename(dirOf(raid), join(place, 'archive', '2026', 'A015'));
    const { found } = await findMoved(db.relinkLegs('RAID', raid), place);
    expect(found.map((item) => [item.targetDir, item.root])).toEqual([[join(place, 'archive', '2026', 'A015'), place]]);
    expect(await stat(found[0]!.targetDir)).toBeTruthy();
  });

  it('will not relink to files that are not the same media, even at the same size', async () => {
    const moved = join(base, 'RAID 1');
    await rename(raid, moved);
    // The smallest file is the one read back: same size, different bytes.
    await writeFile(join(dirOf(moved), 'A015R1AB', 'A015C001.mxf'), 'take two');
    const { found, missing } = await findMoved(db.relinkLegs('RAID', raid), moved);
    expect(found).toEqual([]);
    expect(missing.map((leg) => leg.card)).toEqual(['A015']);
    // A file missing is not the copy either.
    await writeFile(join(dirOf(moved), 'A015R1AB', 'A015C001.mxf'), 'take one');
    await rm(join(dirOf(moved), 'A015R1AB', 'A015C002.mxf'));
    expect((await findMoved(db.relinkLegs('RAID', raid), moved)).found).toEqual([]);
  });
});
