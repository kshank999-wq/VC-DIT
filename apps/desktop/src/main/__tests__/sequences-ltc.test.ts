import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProductionDb } from '../db/production-db';
import { listFolder } from '../media/browse';
import { decodeLtc, labelFrames } from '../media/ltc';
import { readMediaMeta } from '../media/metadata';
import { isPictureFile, pictureKey, sequenceOf } from '../scriptlog/clip-key';
// @ts-expect-error a plain JS helper shared with the fixture script
import { burstSignal, ltcSignal, RATE } from './fixtures/signal.mjs';

const wasm = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
const fixture = (name: string) => join(__dirname, 'fixtures', name);

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vcdit-seq-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A minimal CinemaDNG frame: a little-endian TIFF whose first IFD carries TimeCodes (51043) and FrameRate (51044). */
const dngFrame = (tc: { h: number; m: number; s: number; f: number; dropFrame?: boolean }, rate: [number, number]) => {
  const bcd = (value: number) => ((Math.floor(value / 10) << 4) | value % 10) & 0xff;
  const buffer = Buffer.alloc(8 + 2 + 2 * 12 + 4 + 8 + 8);
  buffer.write('II', 0, 'latin1');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(8, 4);
  buffer.writeUInt16LE(2, 8);
  const values = 8 + 2 + 2 * 12 + 4;
  // TimeCodes: BYTE x 8 at `values`.
  buffer.writeUInt16LE(51043, 10);
  buffer.writeUInt16LE(1, 12);
  buffer.writeUInt32LE(8, 14);
  buffer.writeUInt32LE(values, 18);
  // FrameRate: SRATIONAL x 1 at `values + 8`.
  buffer.writeUInt16LE(51044, 22);
  buffer.writeUInt16LE(10, 24);
  buffer.writeUInt32LE(1, 26);
  buffer.writeUInt32LE(values + 8, 30);
  buffer[values] = bcd(tc.f) | (tc.dropFrame ? 0x40 : 0);
  buffer[values + 1] = bcd(tc.s);
  buffer[values + 2] = bcd(tc.m);
  buffer[values + 3] = bcd(tc.h);
  buffer.writeInt32LE(rate[0], values + 8);
  buffer.writeInt32LE(rate[1], values + 12);
  return buffer;
};

describe('image sequences', () => {
  it('knows a sequence frame from a still, and names the clip once for all its frames', () => {
    expect(sequenceOf('Clip0001_000123.dng')).toEqual({ stem: 'Clip0001', frame: 123, extension: 'dng', separator: '_', digits: 6, written: 'dng' });
    expect(sequenceOf('A001C001_120101_R1AB.0000001.ari')).toMatchObject({ stem: 'A001C001_120101_R1AB', frame: 1 });
    expect(sequenceOf('plate_v2.1001.exr')).toMatchObject({ stem: 'plate_v2', frame: 1001 });
    // Stills: a short number with no dot before it.
    expect(sequenceOf('DSC01234.DNG')).toBeNull();
    expect(sequenceOf('DJI_0001.DNG')).toBeNull();
    expect(isPictureFile('Clip0001_000123.dng')).toBe(true);
    expect(isPictureFile('DSC01234.DNG')).toBe(false);
    // The camera's clip key when its name has one; else the sequence's name.
    expect(pictureKey('A001C001_120101_R1AB.0000001.ari')).toBe('A001C001');
    expect(pictureKey('Clip0001_000123.dng')).toBe('Clip0001');
    expect(pictureKey('C0001.MP4')).toBe('C0001');
  });

  it('reads a CinemaDNG frame\'s timecode and rate', async () => {
    const path = join(base, 'Clip0001_000000.dng');
    await writeFile(path, dngFrame({ h: 11, m: 22, s: 33, f: 12 }, [24000, 1001]));
    const result = await readMediaMeta(path);
    expect(result).toMatchObject({
      ok: true,
      meta: { kind: 'picture', format: 'DNG', tc: { frames: labelFrames(11, 22, 33, 12, 24, false), base: 24, dropFrame: false }, tcFrom: 'header', rate: { num: 24000, den: 1001 }, sequence: true },
    });
    await writeFile(path, Buffer.from('not a tiff'));
    expect(await readMediaMeta(path)).toMatchObject({ ok: false });
  });

  it('is one clip in the production: read once from its first frame, as long as all its frames', async () => {
    const db = await ProductionDb.open(join(base, 'p.vcdit'), { wasm, create: { name: 'HALCYON', code: 'HLC' } });
    try {
      const card = join(base, 'D001');
      const frames = Array.from({ length: 48 }, (_, i) => `CLIP/Clip0001_${String(i).padStart(6, '0')}.dng`);
      await mkdir(join(card, 'CLIP'), { recursive: true });
      for (const name of frames) await writeFile(join(card, ...name.split('/')), dngFrame({ h: 1, m: 0, s: 0, f: 0 }, [24, 1]));
      db.saveTransfer({
        id: 'D001',
        day: 1,
        card: 'D001',
        label: 'CinemaDNG',
        sourceRoot: card,
        sound: false,
        checksum: 'xxHash64',
        startedAt: '2026-10-07T10:00:00Z',
        finishedAt: '2026-10-07T10:01:00Z',
        files: frames.map((path) => ({ path, size: 64, mtimeMs: 0, hash: null, hashedAt: null })),
        destinations: [],
      });
      const pending = db.pendingMeta(1);
      expect(pending.map((item) => item.path)).toEqual(['CLIP/Clip0001_000000.dng']);
      db.saveMeta(1, 'D001', pending[0]!.path, await readMediaMeta(join(card, 'CLIP', 'Clip0001_000000.dng')));
      // Read once: the other 47 frames are not asked for.
      expect(db.pendingMeta(1)).toEqual([]);
      const { pictures } = db.syncMedia(1);
      expect(pictures).toHaveLength(1);
      expect(pictures[0]).toMatchObject({ key: 'Clip0001', meta: { durationSec: 2, tc: { frames: 86_400 } } });
    } finally {
      await db.close();
    }
  });

  it('shows in the Files panel as one line, with its frames and their size together', async () => {
    const dir = join(base, 'PROD', 'CLIP');
    await mkdir(dir, { recursive: true });
    for (let i = 1; i <= 30; i += 1) await writeFile(join(dir, `Clip0001_${String(i).padStart(6, '0')}.dng`), Buffer.alloc(10));
    await writeFile(join(dir, 'Clip0001.wav'), Buffer.alloc(5));
    const listing = await listFolder(join(base, 'PROD'), 'CLIP');
    expect(listing.ok && listing.entries.map((entry) => [entry.name, entry.size, entry.sequence?.frames ?? null])).toEqual([
      ['Clip0001.[000001-000030].dng', 300, 30],
      ['Clip0001.wav', 5, null],
    ]);
    expect(listing.ok && listing.entries[0]!.rel).toBe('CLIP/Clip0001_000001.dng');
  });
});

describe('timecode from a camera\'s audio track (LTC)', () => {
  it('reads LTC started part-way into a frame, back to the clip\'s first frame', () => {
    const signal = ltcSignal({ h: 10, m: 0, s: 0, f: 0 }, 25, 2, { phase: 0.3 });
    expect(decodeLtc(signal, RATE, 25)).toEqual({ frames: labelFrames(10, 0, 0, 0, 25, false), base: 25, dropFrame: false });
    // Without being told the rate, and quieter.
    expect(decodeLtc(ltcSignal({ h: 1, m: 2, s: 3, f: 4 }, 24, 2, { amplitude: 0.05 }), RATE)).toEqual({ frames: labelFrames(1, 2, 3, 4, 24, false), base: 24, dropFrame: false });
  });

  it('reads drop-frame LTC across a minute', () => {
    const signal = ltcSignal({ h: 0, m: 0, s: 59, f: 28 }, 29.97, 1, { dropFrame: true });
    expect(decodeLtc(signal, RATE, 29.97)).toEqual({ frames: labelFrames(0, 0, 59, 28, 30, true), base: 30, dropFrame: true });
  });

  it('finds nothing in a microphone signal or silence', () => {
    expect(decodeLtc(burstSignal(2, 3), RATE, 25)).toBeNull();
    expect(decodeLtc(new Float32Array(RATE), RATE, 25)).toBeNull();
  });

  it('gives a clip with no timecode of its own the LTC on its right channel, not its microphone on the left', async () => {
    const result = await readMediaMeta(fixture('clip-ltc.mov'));
    expect(result).toMatchObject({ ok: true, meta: { kind: 'picture', tc: { frames: labelFrames(10, 0, 0, 0, 25, false), base: 25, dropFrame: false }, tcFrom: 'audio' } });
    // A clip with its own timecode keeps it.
    expect(await readMediaMeta(fixture('clip.mov'))).toMatchObject({ ok: true, meta: { tcFrom: 'header' } });
  });
});
