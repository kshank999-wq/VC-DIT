import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHasher, prepareChecksums } from '../media/checksum';
import { c4id, mhlHashList, writeReports } from '../media/reports';
import { cardFolder, destinationProblem, isRemote, sameOrInside, segment } from '../media/rules';
import { listSource, PART_SUFFIX, runTransfer, type LegPlan } from '../media/transfer';
import { classifyVolume, fromDiskutil, fromWindows } from '../media/volumes';
import { inside, listFolder, searchFolder } from '../media/browse';
import { link, symlink } from 'node:fs/promises';

let base: string;
let card: string;

const write = async (root: string, path: string, content: string | Buffer) => {
  await mkdir(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
  await writeFile(join(root, ...path.split('/')), content);
};

/** Every file under a folder, with its content hash and modification time. */
const snapshot = async (root: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else {
        const info = await stat(join(dir, entry.name));
        out[path] = `${createHash('md5').update(await readFile(join(dir, entry.name))).digest('hex')}@${Math.round(info.mtimeMs)}`;
      }
    }
  };
  await walk(root, '');
  return out;
};

const leg = async (id: string): Promise<LegPlan> => {
  const root = join(base, id);
  await mkdir(root, { recursive: true });
  return { id, name: id.toUpperCase(), root, targetDir: join(root, 'HALCYON', 'SHOOT_DAY_014_2026-10-05', 'CAMERA_ORIGINALS', 'A015') };
};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vcdit-media-'));
  card = join(base, 'A015');
  // A small ALEXA-like card: clips in folders, one bigger than the copy chunk, some OS clutter.
  await write(card, 'A015R1AB/A015C001_261005_R1AB.mxf', Buffer.alloc(3_000_000, 7));
  await write(card, 'A015R1AB/A015C002_261005_R1AB.mxf', 'take two');
  await write(card, 'A015R1AB/A015C003_261005_R1AB.mxf', '');
  await write(card, '.Spotlight-V100/store.db', 'clutter');
  await write(card, 'A015R1AB/._A015C001_261005_R1AB.mxf', 'appledouble');
  await utimes(join(card, 'A015R1AB', 'A015C002_261005_R1AB.mxf'), 1_700_000_000, 1_700_000_000);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('checksums', () => {
  it('match the published values', async () => {
    await prepareChecksums();
    const of = (method: 'xxHash64' | 'MD5' | 'SHA-1', text: string) => {
      const hasher = createHasher(method);
      hasher.update(Buffer.from(text));
      return hasher.digest();
    };
    expect(of('xxHash64', '')).toBe('ef46db3751d8e999');
    expect(of('xxHash64', 'a')).toBe('d24ec4f1a98c6e5b');
    expect(of('MD5', 'abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(of('SHA-1', 'abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('give the same xxHash64 fed in pieces as in one go', async () => {
    await prepareChecksums();
    const data = Buffer.alloc(100_000, 3);
    const whole = createHasher('xxHash64');
    whole.update(data);
    const pieces = createHasher('xxHash64');
    for (let i = 0; i < data.length; i += 7_919) pieces.update(data.subarray(i, i + 7_919));
    expect(pieces.digest()).toBe(whole.digest());
  });
});

describe('listing a card', () => {
  it('lists media in a stable order and leaves out system clutter', async () => {
    const { files } = await listSource(card);
    expect(files.map((file) => file.path)).toEqual([
      'A015R1AB/A015C001_261005_R1AB.mxf',
      'A015R1AB/A015C002_261005_R1AB.mxf',
      'A015R1AB/A015C003_261005_R1AB.mxf',
    ]);
  });
});

describe('the verified copy', () => {
  it('copies a card to two destinations, verifies both, and leaves the card exactly as it was', async () => {
    const before = await snapshot(card);
    const { files } = await listSource(card);
    const legs = [await leg('raid'), await leg('shuttle')];
    const progress: number[] = [];
    const result = await runTransfer(card, files, legs, 'xxHash64', { chunkBytes: 1_000_000, onProgress: (p) => progress.push(p.sourceBytesRead), progressEveryMs: 0 });

    expect(await snapshot(card)).toEqual(before);
    expect(result.stopped).toBe(false);
    for (const file of result.files) {
      expect(file.sourceHash).toMatch(/^[0-9a-f]{16}$/);
      expect(file.legs['raid']).toEqual({ state: 'verified' });
      expect(file.legs['shuttle']).toEqual({ state: 'verified' });
    }
    for (const plan of legs) {
      const copy = await snapshot(plan.targetDir);
      expect(Object.keys(copy).some((path) => path.endsWith(PART_SUFFIX))).toBe(false);
      // Same content and the card's modification time (to the second).
      for (const [path, value] of Object.entries(copy)) expect(value.split('@')[0]).toBe(before[path]!.split('@')[0]);
      const info = await stat(join(plan.targetDir, 'A015R1AB', 'A015C002_261005_R1AB.mxf'));
      expect(Math.round(info.mtimeMs / 1000)).toBe(1_700_000_000);
    }
    expect(result.legs['raid']).toMatchObject({ phase: 'done', problemFiles: 0, error: null });
    expect(progress.at(-1)).toBe(3_000_008);
  });

  it('fails a copy whose read-back does not match, keeps it out of its real name, and a retry fixes it', async () => {
    const { files } = await listSource(card);
    const [raid, shuttle] = [await leg('raid'), await leg('shuttle')];
    const result = await runTransfer(card, files, [raid, shuttle], 'MD5', {
      afterCopy: async (legId, written, file) => {
        // A bit flipped on the way to the shuttle.
        if (legId === 'shuttle' && file.path.endsWith('C002_261005_R1AB.mxf')) await writeFile(written, 'take twO');
      },
    });
    const bad = result.files.find((file) => file.path.endsWith('C002_261005_R1AB.mxf'))!;
    expect(bad.legs['raid']).toEqual({ state: 'verified' });
    expect(bad.legs['shuttle']).toMatchObject({ state: 'failed', error: expect.stringMatching(/mismatch/) });
    expect(result.legs['shuttle']!.problemFiles).toBe(1);
    const shuttleFiles = Object.keys(await snapshot(shuttle.targetDir));
    expect(shuttleFiles).not.toContain('A015R1AB/A015C002_261005_R1AB.mxf');
    expect(shuttleFiles.some((path) => path.endsWith(PART_SUFFIX))).toBe(false);

    const retried = await runTransfer(card, [files.find((file) => file.path === bad.path)!], [shuttle], 'MD5');
    expect(retried.files[0]!.legs['shuttle']).toEqual({ state: 'verified' });
  });

  it('never overwrites: a matching file counts as already there, a different one fails and is left alone', async () => {
    const { files } = await listSource(card);
    const raid = await leg('raid');
    await write(raid.targetDir, 'A015R1AB/A015C002_261005_R1AB.mxf', 'take two');
    await write(raid.targetDir, 'A015R1AB/A015C003_261005_R1AB.mxf', 'something else');
    const result = await runTransfer(card, files, [raid], 'SHA-1');
    const byName = Object.fromEntries(result.files.map((file) => [file.path.split('/').pop(), file.legs['raid']]));
    expect(byName['A015C001_261005_R1AB.mxf']).toEqual({ state: 'verified' });
    expect(byName['A015C002_261005_R1AB.mxf']).toEqual({ state: 'already-there' });
    expect(byName['A015C003_261005_R1AB.mxf']).toMatchObject({ state: 'failed', error: expect.stringMatching(/not overwritten/) });
    expect(await readFile(join(raid.targetDir, 'A015R1AB', 'A015C003_261005_R1AB.mxf'), 'utf8')).toBe('something else');
  });

  it('stops a destination that is missing and finishes the others', async () => {
    const { files } = await listSource(card);
    const raid = await leg('raid');
    const gone: LegPlan = { id: 'gone', name: 'GONE', root: join(base, 'unplugged'), targetDir: join(base, 'unplugged', 'A015') };
    const result = await runTransfer(card, files, [raid, gone], 'xxHash64');
    expect(result.legs['gone']).toMatchObject({ error: expect.stringMatching(/not available/), problemFiles: 3 });
    expect(result.files.every((file) => file.legs['raid']?.state === 'verified')).toBe(true);
    // Nothing was created where the unplugged drive used to be.
    await expect(stat(join(base, 'unplugged'))).rejects.toThrow();
  });

  it('when stopped, removes its unverified copies and says so', async () => {
    const { files } = await listSource(card);
    const raid = await leg('raid');
    const controller = new AbortController();
    const result = await runTransfer(card, files, [raid], 'xxHash64', {
      signal: controller.signal,
      chunkBytes: 1_000_000,
      afterCopy: async () => controller.abort(),
    });
    expect(result.stopped).toBe(true);
    expect(result.files.every((file) => file.legs['raid']?.state === 'failed')).toBe(true);
    const left = await snapshot(raid.root).catch(() => ({}));
    expect(Object.keys(left).filter((path) => path.endsWith(PART_SUFFIX))).toEqual([]);
  });
});

describe('a speed limit', () => {
  it('holds writes to the limit, takes a new limit at once, and goes full speed without one', async () => {
    const card = join(base, 'card');
    await mkdir(card, { recursive: true });
    await writeFile(join(card, 'a.mxf'), Buffer.alloc(600_000, 7));
    const plan = (name: string): LegPlan => ({ id: name, name, root: join(base, name), targetDir: join(base, name, 'A015') });
    await mkdir(join(base, 'slow'));
    await mkdir(join(base, 'fast'));
    await mkdir(join(base, 'changed'));
    const { files } = await listSource(card);

    let started = Date.now();
    const slow = await runTransfer(card, files, [plan('slow')], 'xxHash64', { chunkBytes: 100_000, limit: () => 1_000_000 });
    const slowMs = Date.now() - started;
    expect(slow.legs['slow']!.error).toBeNull();
    // 600 kB at 1 MB/s: the last chunk may go out as the time comes, so at least half a second.
    expect(slowMs).toBeGreaterThanOrEqual(450);

    started = Date.now();
    await runTransfer(card, files, [plan('fast')], 'xxHash64', { chunkBytes: 100_000, limit: () => null });
    expect(Date.now() - started).toBeLessThan(slowMs);

    // Lifted part-way: the rest goes at full speed.
    let limit: number | null = 200_000;
    setTimeout(() => (limit = null), 150);
    started = Date.now();
    const changed = await runTransfer(card, files, [plan('changed')], 'xxHash64', { chunkBytes: 100_000, limit: () => limit });
    expect(changed.files[0]!.legs['changed']!.state).toBe('verified');
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('transfer records', () => {
  it('writes an ASC MHL generation with its chain, and the CSV and JSON logs', async () => {
    const { files } = await listSource(card);
    const raid = await leg('raid');
    const result = await runTransfer(card, files, [raid], 'xxHash64');
    const reportsDir = join(raid.root, 'HALCYON', 'SHOOT_DAY_014_2026-10-05', 'REPORTS', 'ingest_verification');
    const written = await writeReports(result, [raid], { raid: { card: 'A015', tool: { name: 'VC DIT', version: '0.1.0' }, reportsDir } });
    expect(written[0]!.error).toBeNull();

    const mhl = await readFile(written[0]!.mhl!, 'utf8');
    expect(written[0]!.mhl).toMatch(/ascmhl[\\/]0001_A015_\d{8}_\d{6}Z\.mhl$/);
    expect(mhl).toContain('<hashlist version="2.0" xmlns="urn:ASC:MHL:v2.0">');
    expect(mhl).toContain('<process>transfer</process>');
    expect(mhl.match(/<xxh64 action="original"/g)).toHaveLength(3);
    expect(mhl).toContain(`>${result.files[1]!.sourceHash}</xxh64>`);

    const chain = await readFile(join(raid.targetDir, 'ascmhl', 'ascmhl_chain.xml'), 'utf8');
    expect(chain).toContain('<hashlist sequencenr="1">');
    expect(chain).toContain(`<c4>${c4id(mhl)}</c4>`);

    const csv = await readFile(written[0]!.csv!, 'utf8');
    expect(csv.split('\n')[0]).toBe('file,size_bytes,checksum_method,card_checksum,destination,result,detail');
    expect(csv).toContain('A015R1AB/A015C002_261005_R1AB.mxf,8,xxHash64,');
    expect(JSON.parse(await readFile(written[0]!.csv!.replace(/\.csv$/, '.json'), 'utf8'))).toMatchObject({ method: 'xxHash64' });

    // A second pass adds generation 2 to the same chain.
    const again = await runTransfer(card, files, [raid], 'xxHash64');
    await writeReports(again, [raid], { raid: { card: 'A015', tool: { name: 'VC DIT', version: '0.1.0' }, reportsDir } });
    const chained = await readFile(join(raid.targetDir, 'ascmhl', 'ascmhl_chain.xml'), 'utf8');
    expect(chained).toContain('<hashlist sequencenr="1">');
    expect(chained).toContain('<hashlist sequencenr="2">');
    expect(again.files.every((file) => file.legs['raid']?.state === 'already-there')).toBe(true);
  });

  it('lists only verified files in the MHL, and none when nothing verified', async () => {
    const { files } = await listSource(card);
    const raid = await leg('raid');
    const result = await runTransfer(card, files, [raid], 'MD5', { afterCopy: async (_leg, written) => writeFile(written, 'garbage') });
    expect(mhlHashList(result, raid, { card: 'A015', tool: { name: 'VC DIT', version: '1' }, reportsDir: base }, new Date())).toBeNull();
  });

  it('makes C4 IDs of the right shape', () => {
    const id = c4id('hello');
    expect(id).toMatch(/^c4[1-9A-HJ-NP-Za-km-z]{88}$/);
    expect(c4id('hello')).toBe(id);
    expect(c4id('hello!')).not.toBe(id);
  });
});

describe('where copies may go', () => {
  it('never onto a card, into a card, or into a folder holding a card', () => {
    expect(destinationProblem('/Volumes/A015', ['/Volumes/A015'], 'darwin')).toMatch(/never written/);
    expect(destinationProblem('/Volumes/A015/backup', ['/Volumes/A015'], 'darwin')).toMatch(/never written/);
    expect(destinationProblem('/Volumes', ['/Volumes/A015'], 'darwin')).toMatch(/contains a card/);
    expect(destinationProblem('/Volumes/RAID', ['/Volumes/A015'], 'darwin')).toBeNull();
    expect(destinationProblem('/Volumes/A0151', ['/Volumes/A015'], 'darwin')).toBeNull();
    expect(destinationProblem('e:\\Backup', ['E:\\'], 'win32')).toMatch(/never written/);
    expect(destinationProblem('F:\\', ['E:\\'], 'win32')).toBeNull();
    expect(sameOrInside('/a/b', '/a', 'linux')).toBe(true);
    expect(sameOrInside('/A/b', '/a', 'linux')).toBe(false);
  });

  it('builds the spec folder model with safe names', () => {
    const request = { production: { name: 'HALCYON', code: 'HLC' }, day: { number: 14, date: '2026-10-05' } };
    expect(cardFolder('/R', request, false, 'A015').replace(/\\/g, '/')).toBe('/R/HALCYON/SHOOT_DAY_014_2026-10-05/CAMERA_ORIGINALS/A015');
    expect(cardFolder('/R', request, true, '888_D14').replace(/\\/g, '/')).toBe('/R/HALCYON/SHOOT_DAY_014_2026-10-05/SOUND_ORIGINALS/888_D14');
    expect(segment('A:B/C*?. ')).toBe('A_B_C_');
    expect(segment('..')).toBe('UNTITLED');
  });
});

describe('recognising a volume', () => {
  it('knows camera cards, sound cards, empty volumes and its own drives', async () => {
    expect(await classifyVolume(card)).toEqual({ detected: 'ARRI · MXF', role: 'Camera' });

    const sound = join(base, 'snd');
    await write(sound, 'FOLDER01/14A-T01.WAV', 'riff');
    await write(sound, 'FOLDER01/14A-T02.WAV', 'riff');
    expect(await classifyVolume(sound)).toEqual({ detected: 'Sound · 2 WAV', role: 'Sound' });

    const red = join(base, 'red');
    await write(red, 'A001_C001_1005XY.RDM/A001_C001_1005XY.RDC/A001_C001_1005XY_001.R3D', 'r3d');
    expect((await classifyVolume(red)).detected).toBe('RED · R3D');

    const sony = join(base, 'sony');
    await write(sony, 'PRIVATE/M4ROOT/CLIP/C0001.MP4', 'mp4');
    expect(await classifyVolume(sony)).toEqual({ detected: 'Sony', role: 'Camera' });

    const empty = join(base, 'empty');
    await mkdir(empty);
    expect(await classifyVolume(empty)).toEqual({ detected: 'Empty volume', role: 'Other' });

    const raid = join(base, 'raidvol');
    await write(raid, 'HALCYON/SHOOT_DAY_013_2026-10-04/CAMERA_ORIGINALS/A012/x.mxf', 'x');
    expect(await classifyVolume(raid)).toEqual({ detected: 'VC DIT media drive', role: 'Destination' });
  });
});

describe('what the device is', () => {
  const plist = (entries: Record<string, string | boolean>) =>
    `<plist><dict>${Object.entries(entries)
      .map(([key, value]) => `<key>${key}</key>${typeof value === 'boolean' ? `<${value}/>` : `<string>${value}</string>`}`)
      .join('')}</dict></plist>`;

  it('reads a RED mag, an SSD and an AppleRAID set from diskutil, using the APFS store for the model', () => {
    const mag = fromDiskutil(plist({ VolumeName: 'A001_C001', FilesystemName: 'exfat', BusProtocol: 'USB', Internal: false, SolidState: true, MediaName: 'RED MINI-MAG 960GB', RAIDMaster: false }), null, 'A001');
    expect(mag).toEqual({ name: 'A001_C001', kind: 'USB drive', filesystem: 'exfat', device: { model: 'RED MINI-MAG 960GB', bus: 'USB', solidState: true, raid: false } });

    const apfsVolume = plist({ VolumeName: 'SHTL_08', FilesystemUserVisibleName: 'APFS', MediaName: '', BusProtocol: 'USB', Internal: false });
    const store = plist({ MediaName: 'Samsung PSSD T7', BusProtocol: 'USB', SolidState: true, Internal: false });
    expect(fromDiskutil(apfsVolume, store, 'SHTL_08').device).toEqual({ model: 'Samsung PSSD T7', bus: 'USB', solidState: true, raid: false });

    const raid = fromDiskutil(plist({ VolumeName: 'HLC_RAID', BusProtocol: 'Thunderbolt', Internal: false, RAIDMaster: true, SolidState: false }), null, 'HLC_RAID');
    expect(raid).toMatchObject({ kind: 'Thunderbolt drive', device: { raid: true, solidState: false } });

    const share = fromDiskutil(plist({ VolumeName: 'PROD', FilesystemType: 'smbfs' }), null, 'PROD');
    expect(share).toMatchObject({ kind: 'Network share', device: { bus: 'Network' } });
  });

  it('reads the disk behind a Windows drive letter', () => {
    expect(fromWindows({ VolumeName: 'SHTL_08', FileSystem: 'exFAT', DriveType: 3, Model: 'Samsung PSSD T9', Bus: 'USB', Media: 'SSD' }, 'E:')).toEqual({
      name: 'SHTL_08',
      kind: 'USB drive',
      filesystem: 'exFAT',
      device: { model: 'Samsung PSSD T9', bus: 'USB', solidState: true, raid: false },
    });
    expect(fromWindows({ VolumeName: 'RAID', FileSystem: 'NTFS', DriveType: 3, Model: 'Storage Space', Bus: 'Spaces', Media: 'Unspecified' }, 'R:').device).toMatchObject({ raid: true, solidState: null });
    expect(fromWindows({ VolumeName: 'B001', FileSystem: 'exFAT', DriveType: 2, Model: 'SD Card Reader', Bus: 'SD', Media: '' }, 'F:').kind).toBe('SD card');
    expect(fromWindows({ ProviderName: '\\\\nas\\prod', FileSystem: 'NTFS', DriveType: 4 }, 'Z:')).toMatchObject({ name: '\\\\nas\\prod', kind: 'Network share', device: { bus: 'Network' } });
  });

  it('knows which destinations are on the far end of a network', () => {
    expect(isRemote('/Users/dit/Library/CloudStorage/Dropbox/Dailies')).toBe(true);
    expect(isRemote('Drive', 'lucidfs', 'filespace')).toBe(true);
    expect(isRemote('Network share', 'smbfs')).toBe(true);
    expect(isRemote('\\\\nas\\prod')).toBe(true);
    expect(isRemote('Thunderbolt drive', 'APFS', 'HLC_RAID_01')).toBe(false);
    expect(isRemote('/Volumes/RAID/Boxes')).toBe(false);
  });
});

describe('browsing a drive', () => {
  it('lists a folder, folders first and in natural order, marks hard links, and hides clutter and unfinished copies', async () => {
    const prod = join(base, 'HALCYON');
    await mkdir(join(prod, 'DAY', 'A10'), { recursive: true });
    await mkdir(join(prod, 'DAY', 'A2'), { recursive: true });
    await writeFile(join(prod, 'DAY', 'clip.mxf'), 'abc');
    await link(join(prod, 'DAY', 'clip.mxf'), join(prod, 'DAY', 'A2', 'clip.mxf'));
    await writeFile(join(prod, 'DAY', '.DS_Store'), '');
    await writeFile(join(prod, 'DAY', 'half.mxf.vcdit-part'), '');
    await symlink('/etc', join(prod, 'DAY', 'out'));
    const listing = await listFolder(prod, 'DAY');
    if (!listing.ok) throw new Error(listing.reason);
    expect(listing.entries.map((item) => [item.name, item.kind, item.linked, item.items])).toEqual([
      ['A2', 'folder', false, 1],
      ['A10', 'folder', false, 0],
      ['clip.mxf', 'file', true, null],
      ['out', 'link', true, null],
    ]);
    expect(listing.entries[2]).toMatchObject({ rel: 'DAY/clip.mxf', size: 3 });
    expect(await listFolder(prod, 'NOT_YET')).toEqual({ ok: false, reason: 'Not on this drive (yet).' });
  });

  it('never leaves the production folder', async () => {
    const prod = join(base, 'HALCYON');
    await mkdir(prod, { recursive: true });
    expect(inside(prod, '../secret')).toBeNull();
    expect(inside(prod, 'DAY/../../x')).toBeNull();
    expect(inside(prod, 'DAY/A2')).toBe(join(prod, 'DAY', 'A2'));
    expect(await listFolder(prod, '..')).toEqual({ ok: false, reason: 'That folder is outside the production.' });
  });

  it('finds names anywhere under the production folder, nearest first', async () => {
    const prod = join(base, 'HALCYON');
    await mkdir(join(prod, 'D1', 'CAMERA_ORIGINALS', 'A015'), { recursive: true });
    await writeFile(join(prod, 'D1', 'CAMERA_ORIGINALS', 'A015', 'A015C002.mxf'), 'x');
    await writeFile(join(prod, 'D1', 'a015-notes.txt'), 'x');
    const found = await searchFolder(prod, 'a015');
    if (!found.ok) throw new Error(found.reason);
    expect(found.entries.map((item) => item.rel)).toEqual(['D1/a015-notes.txt', 'D1/CAMERA_ORIGINALS/A015', 'D1/CAMERA_ORIGINALS/A015/A015C002.mxf']);
    expect(found.complete).toBe(true);
  });
});
