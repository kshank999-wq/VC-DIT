import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProductionDb, type TransferRecord } from '../db/production-db';
import { dayEntries, dayReportHtml } from '../reports/day-report';
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


beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vcdit-reports-'));
  db = await ProductionDb.open(join(base, 'p.vcdit'), { wasm, create: { name: 'HALCYON', code: 'HLC' } });
  db.updateDay(1, { date: '2026-10-07', locations: 'Hangar <B>', operator: { name: 'Sam Reyes', initials: 'SR' } });
  organizer = new OrganizeService({ db: () => db, changed: () => undefined });
  await ingest();
  db.importLog(1, 'day1.csv', parseScriptLog('day1.csv', 'Scene,Setup,Take,Clip,Circle,VFX\n14,A,1,A015C001,,\n14,B,3,A015C002,Y,Sky\n'));
  await organizer.run();
});
afterEach(async () => {
  await db.close();
  await rm(base, { recursive: true, force: true });
});

describe('the day\'s reports', () => {
  it('lists each step\'s record with its files on the drives', async () => {
    // The ingest wrote its MHL and logs; here they are made as the media engine leaves them.
    for (const leg of legs) {
      await mkdir(join(leg.targetDir, 'ascmhl'), { recursive: true });
      await writeFile(join(leg.targetDir, 'ascmhl', '0001_A015_20261007_143100Z.mhl'), '<hashlist/>');
    }
    await mkdir(join(legs[0]!.root, 'reports'), { recursive: true });
    await writeFile(join(legs[0]!.root, 'reports', 'A015_20261007_143100Z.csv'), 'file\n');
    db.saveDelivery(1, {
      package: 'dailies',
      packageName: 'Synced dailies',
      destinationId: 'shtl',
      destination: 'SHTL_03',
      root: join(base, 'SHTL'),
      source: 'RAID',
      files: 20,
      bytes: 4e9,
      verified: 19,
      alreadyThere: 0,
      failed: 1,
      retries: 0,
      startedAt: '2026-10-07T20:00:00Z',
      finishedAt: '2026-10-07T20:10:00Z',
      problems: [{ path: 'SYNCED_DAILIES/x.mov', error: 'Checksum mismatch' }],
      failedFiles: [],
      mhl: null,
    });

    const entries = await dayEntries(db, 1, organizer.view());
    const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
    expect(byId['ingest:A015']).toMatchObject({ step: 'verify', status: 'done', word: 'Safe to format', card: 'A015', covers: 'ASC MHL · 4 files · 2 destinations · xxHash64' });
    expect(byId['ingest:A015']!.files).toEqual([
      join(legs[0]!.targetDir, 'ascmhl', '0001_A015_20261007_143100Z.mhl'),
      join(legs[0]!.root, 'reports', 'A015_20261007_143100Z.csv'),
      join(legs[1]!.targetDir, 'ascmhl', '0001_A015_20261007_143100Z.mhl'),
    ]);
    expect(byId['script']).toMatchObject({ status: 'done', covers: '2 entries · 2 matched · 0 to review · 1 VFX' });
    expect(byId['scenes']).toMatchObject({ status: 'done', covers: '6 clips placed · RAID, SHUTTLE' });
    expect(byId['vfx']).toMatchObject({ status: 'needs', covers: '1 shot · 0 mirrored · 0 sent to VC VFX Prep' });
    expect(byId['delivery:dailies:shtl']).toMatchObject({ status: 'problem', covers: '20 files · 4.0 GB from RAID · 1 not verified' });
  });

  it('puts the whole day on printable pages, escaping what people typed', async () => {
    const page = dayReportHtml(db, 1, await dayEntries(db, 1, organizer.view()), { name: 'VC DIT', version: '1.2.3' });
    expect(page).toContain('<h1>HALCYON <span class="muted">HLC</span></h1>');
    expect(page).toContain('Hangar &lt;B&gt;');
    expect(page).not.toContain('Hangar <B>');
    expect(page).toContain('DIT Sam Reyes');
    expect(page).toMatch(/<td>A015<\/td><td>RAID<\/td><td>4<\/td>/);
    expect(page).toContain('<td>A015C002</td>');
    expect(page).toContain('Nothing delivered.');
  });
});
