import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DELIVERY, deliveryNeed, type DeliverySettings } from '../../shared/project';
import { ProductionDb, type EditorialRow } from '../db/production-db';
import { DeliveryService, type RunTransfer } from '../delivery/delivery-service';
import { editorialAle, editorialCsv } from '../delivery/editorial';
import { createHasher, prepareChecksums } from '../media/checksum';
import { writeReports } from '../media/reports';
import { runTransfer } from '../media/transfer';

const wasm = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');

/** The transfer worker's work, in this thread. */
const inline: RunTransfer = async (plan, options = {}) => {
  const result = await runTransfer(plan.sourceRoot, plan.files, plan.legs, plan.method, { signal: options.signal, onProgress: options.onProgress });
  return { result, reports: await writeReports(result, plan.legs, plan.contexts, plan.allLegs) };
};

const hash = async (bytes: Buffer) => {
  await prepareChecksums();
  const hasher = createHasher('xxHash64');
  hasher.update(bytes);
  return hasher.digest();
};

let base: string;
let db: ProductionDb;
let service: DeliveryService;
let raidDay: string;
let shuttleDay: string;

const put = async (path: string, bytes: Buffer | string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
};

const CLIPS = [Buffer.alloc(300_000, 1), Buffer.alloc(200_000, 2), Buffer.alloc(100_000, 3), Buffer.alloc(50_000, 4)];

const choose = (patch: Partial<DeliverySettings>) => db.saveDeliverySettings({ ...DEFAULT_DELIVERY, destinations: ['shtl'], ...patch });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vcdit-delivery-'));
  db = await ProductionDb.open(join(base, 'p.vcdit'), { wasm, create: { name: 'NIGHTJAR', code: 'NJR', frameRate: '25 fps', checksum: 'xxHash64' } });
  db.updateDay(1, { date: '2026-10-07' });
  raidDay = join(base, 'RAID', 'NIGHTJAR', 'SHOOT_DAY_001_2026-10-07');
  shuttleDay = join(base, 'SHTL', 'NIGHTJAR', 'SHOOT_DAY_001_2026-10-07');
  await mkdir(join(base, 'SHTL'));

  const files = [];
  for (const [index, bytes] of CLIPS.entries()) {
    const path = `CLIPS/A001C00${index + 1}.mov`;
    await put(join(raidDay, 'CAMERA_ORIGINALS', 'A001', ...path.split('/')), bytes);
    // The fourth clip has gone bad on the RAID since it was ingested.
    files.push({ path, size: bytes.length, mtimeMs: 0, hash: index === 3 ? 'deadbeefdeadbeef' : await hash(bytes), hashedAt: 'x' });
  }
  db.saveTransfer({ id: 'A001', day: 1, card: 'A001', label: 'A001', sourceRoot: '/card', sound: false, checksum: 'xxHash64', startedAt: 'x', finishedAt: 'y', files, destinations: [] });
  await put(join(raidDay, 'CAMERA_ORIGINALS', 'A001', 'ascmhl', '0001_A001.mhl'), '<hashlist/>');
  await put(join(raidDay, 'SOUND_ORIGINALS', 'S001', '14B-03.WAV'), Buffer.alloc(4_000, 9));
  await put(join(raidDay, 'SYNCED_DAILIES', 'SCENE_014', '14B-03.mov'), Buffer.alloc(8_000, 7));
  await put(join(raidDay, 'REPORTS', 'ingest_verification', 'A001.csv'), 'file,result\n');
  await put(join(raidDay, 'REPORTS', 'dailies', 'DAILIES.csv'), 'take\n');
  await put(join(raidDay, 'REPORTS', 'notes.txt'), 'wrap 19:40');

  // The shuttle already has one clip as it should be, and a different file under another clip's name.
  await put(join(shuttleDay, 'CAMERA_ORIGINALS', 'A001', 'CLIPS', 'A001C002.mov'), CLIPS[1]!);
  await put(join(shuttleDay, 'CAMERA_ORIGINALS', 'A001', 'CLIPS', 'A001C003.mov'), Buffer.alloc(100_000, 8));

  service = new DeliveryService({
    db: () => db,
    places: () => [
      { id: 'raid', name: 'RAID', kind: 'Destination', root: join(base, 'RAID') },
      { id: 'shtl', name: 'SHTL_03', kind: 'Shuttle', root: join(base, 'SHTL') },
    ],
    runTransfer: inline,
    tool: { name: 'VC DIT', version: 'test' },
    changed: () => undefined,
  });
});
afterEach(async () => {
  await db.close();
  await rm(base, { recursive: true, force: true });
});

const files = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (relative: string) => {
    for (const entry of await readdir(join(dir, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else out.push(path);
    }
  };
  await walk('');
  return out.sort();
};

describe('what of the day is where', () => {
  it('finds each part on the drive with the most of it, and counts what the others already hold', async () => {
    await service.refresh();
    const view = service.view();
    const camera = view.parts.find((part) => part.id === 'camera')!;
    expect(camera).toMatchObject({ sourceId: 'raid', source: 'RAID', files: 4, bytes: 650_000 });
    // Same names and sizes on the shuttle: the identical clip and the impostor both look present.
    expect(camera.present['shtl']).toBe(300_000);
    expect(view.parts.find((part) => part.id === 'reports')).toMatchObject({ files: 1 });
    expect(view.parts.find((part) => part.id === 'reports-ingest')).toMatchObject({ files: 1 });
    expect(view.parts.find((part) => part.id === 'looks')).toMatchObject({ sourceId: null, files: 0 });
    expect(view.places.map((place) => place.freeBytes !== null)).toEqual([true, true]);

    // The shuttle needs the rest of the originals, the sound and the ingest log; the RAID is their source.
    expect(deliveryNeed(view, ['ocf'], 'shtl')).toBe(350_000 + 4_000 + 'file,result\n'.length);
    expect(deliveryNeed(view, ['ocf'], 'raid')).toBe(0);
    // A part two packages share counts once.
    expect(deliveryNeed(view, ['ocf', 'edit'], 'shtl')).toBe(deliveryNeed(view, ['ocf'], 'shtl'));
  });
});

describe('a delivery', () => {
  it('copies and verifies each package, never overwrites, checks originals against ingest, and writes the manifest', async () => {
    choose({ packages: ['ocf', 'dailies', 'reports'] });
    await service.start();
    expect(service.busy()).toBe(true);
    await service.idle();

    const records = db.deliveries(1);
    expect(records.map((record) => record.package)).toEqual(['ocf', 'dailies', 'reports']);
    const ocf = records[0]!;
    expect(ocf).toMatchObject({ destination: 'SHTL_03', source: 'RAID', files: 6, verified: 3, alreadyThere: 1, failed: 2, retries: 0 });
    expect(ocf.problems.find((problem) => problem.path.endsWith('A001C003.mov'))?.error).toMatch(/not overwritten/);
    expect(ocf.problems.find((problem) => problem.path.endsWith('A001C004.mov'))?.error).toMatch(/ingested with/);
    expect(records[1]).toMatchObject({ files: 2, verified: 2, failed: 0 });
    expect(records[2]).toMatchObject({ files: 1, verified: 1, failed: 0 });

    const delivered = await files(shuttleDay);
    expect(delivered).toContain('CAMERA_ORIGINALS/A001/CLIPS/A001C001.mov');
    expect(delivered).toContain('SYNCED_DAILIES/SCENE_014/14B-03.mov');
    expect(delivered).toContain('REPORTS/notes.txt');
    // The bad copy went nowhere, the impostor is untouched, and the ingest's own MHL history is not copied.
    expect(delivered).not.toContain('CAMERA_ORIGINALS/A001/CLIPS/A001C004.mov');
    expect((await readFile(join(shuttleDay, 'CAMERA_ORIGINALS', 'A001', 'CLIPS', 'A001C003.mov')))[0]).toBe(8);
    expect(delivered.some((path) => path.endsWith('.vcdit-part') || path.startsWith('CAMERA_ORIGINALS/A001/ascmhl'))).toBe(false);
    // An ASC MHL of what arrived, and the logs and manifest beside the other reports.
    const mhl = await readFile(ocf.mhl!, 'utf8');
    expect(mhl).toContain('CAMERA_ORIGINALS/A001/CLIPS/A001C001.mov');
    expect(mhl).not.toContain('A001C004');
    expect(delivered.filter((path) => path.startsWith('REPORTS/delivery/')).map((path) => path.replace(/_\d{8}_\d{6}Z/, ''))).toEqual(
      expect.arrayContaining(['REPORTS/delivery/DELIVERY_OCF.csv', 'REPORTS/delivery/DELIVERY_DAILIES.json', 'REPORTS/delivery/DELIVERY_MANIFEST.csv']),
    );

    // The DIT clears the impostor; a retry copies only what failed, and the bad original still refuses.
    await rm(join(shuttleDay, 'CAMERA_ORIGINALS', 'A001', 'CLIPS', 'A001C003.mov'));
    await service.retry('ocf', 'shtl');
    await service.idle();
    const again = db.deliveries(1)[0]!;
    expect(again).toMatchObject({ files: 6, verified: 4, alreadyThere: 1, failed: 1, retries: 1 });
    expect(again.failedFiles.map((file) => file.path)).toEqual(['CAMERA_ORIGINALS/A001/CLIPS/A001C004.mov']);
    expect((await stat(join(shuttleDay, 'CAMERA_ORIGINALS', 'A001', 'CLIPS', 'A001C003.mov'))).size).toBe(100_000);
  });

  it('writes the editorial ALE and sync list beside the originals and delivers them', async () => {
    choose({ packages: ['edit'] });
    await service.start();
    await service.idle();
    const ale = (await files(join(raidDay, 'EDITORIAL'))).find((name) => name.endsWith('.ale'))!;
    expect(ale).toMatch(/^NJR_D001_\d{8}_\d{6}Z\.ale$/);
    const delivered = await readFile(join(shuttleDay, 'EDITORIAL', ale), 'utf8');
    expect(delivered).toContain('Heading');
    expect(delivered).toMatch(/^A001C001\tV\t/m);
    expect(db.deliveries(1)[0]).toMatchObject({ package: 'edit', failed: 2 });
  });

  it('says why it cannot start', async () => {
    choose({ packages: [] });
    await expect(service.start()).rejects.toThrow('Choose at least one package.');
    choose({ packages: ['vfx'] });
    await expect(service.start()).rejects.toThrow(/has anything on the drives/);
    choose({ packages: ['ocf'], destinations: [] });
    await expect(service.start()).rejects.toThrow('Choose at least one destination.');
    db.saveDeliverySettings({ ...DEFAULT_DELIVERY, packages: ['ocf'], destinations: ['gone'], folders: [{ id: 'gone', name: 'VENDOR', path: join(base, 'nowhere') }] });
    await expect(service.start()).rejects.toThrow('VENDOR cannot be reached.');
    expect(service.busy()).toBe(false);
  });
});

describe('the editorial lists', () => {
  const row = (patch: Partial<EditorialRow> = {}): EditorialRow => ({
    clip: 'A015C002',
    card: 'A015',
    file: 'A015C002_261007_R1AB.mov',
    tc: { frames: 1217772, base: 24 },
    rate: { num: 24000, den: 1001 },
    durationSec: 10.01,
    scene: '14',
    setup: 'B',
    take: '3',
    circle: true,
    notes: 'great\tperformance\nhold',
    roll: 'A015',
    soundRoll: 'S004',
    soundFile: '14B-03.WAV',
    sync: 'Timecode',
    syncFrames: -12.5,
    look: 'NJR_Show_v3.cube',
    ...patch,
  });

  it('writes an ALE editors can import', () => {
    const ale = editorialAle([row(), row({ clip: 'B007C001', take: '', tc: null, soundFile: '', sync: 'None', syncFrames: null, circle: false })], '23.976 fps');
    const lines = ale.split('\n');
    expect(lines.slice(0, 5)).toEqual(['Heading', 'FIELD_DELIM\tTABS', 'VIDEO_FORMAT\t1080', 'AUDIO_FORMAT\t48khz', 'FPS\t23.976']);
    const columns = lines[lines.indexOf('Column') + 1]!.split('\t');
    const data = lines.slice(lines.indexOf('Data') + 1, -1).map((line) => Object.fromEntries(line.split('\t').map((value, i) => [columns[i], value])));
    expect(data[0]).toMatchObject({ Name: '14B-03', Tracks: 'VA1A2', Start: '14:05:40:12', End: '14:05:50:12', Tape: 'A015C002', 'Sync Offset': '-12.5', Circled: 'Yes' });
    // Tabs and line breaks in a note never break the columns.
    expect(data[0]!['Comments']).toBe('great performance hold');
    expect(data[1]).toMatchObject({ Name: 'B007C001', Tracks: 'V', Start: '', 'Sync Method': 'None' });
  });

  it('writes the same as a CSV', () => {
    const csv = editorialCsv([row()]);
    expect(csv.split('\n')[0]).toBe('clip,card,file,scene,setup,take,circled,tc_start,tc_end,fps,sound_roll,sound_file,sync,sync_offset_frames,look,notes');
    expect(csv).toContain('A015C002,A015,A015C002_261007_R1AB.mov,14,B,3,yes,14:05:40:12,14:05:50:12,23.976,S004,14B-03.WAV,Timecode,-12.5,NJR_Show_v3.cube,"great\tperformance\nhold"');
  });
});
