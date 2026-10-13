import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderArgs, type RenderJob } from '../dailies/render-args';
import { locateFfmpeg, runFfmpeg, type Ffmpeg } from '../ffmpeg/ffmpeg';
import { labelFrames } from '../media/ltc';
import { readMediaMeta } from '../media/metadata';
import { rateOfDecimal } from '../media/metadata/frames';
import { sequencePattern } from '../scriptlog/clip-key';

/**
 * Image sequence frames: DPX and OpenEXR headers read for timecode and rate
 * (against headers laid out as each specification defines them, and against
 * real files FFmpeg writes), and dailies rendered from a whole sequence.
 */

const ffmpeg = await locateFfmpeg(null);
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vcdit-frames-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A DPX header (SMPTE 268M): magic, TV header time code at 1920, film frame rate at 1724, TV temporal rate at 1940. */
const dpx = (options: { big: boolean; tc: number; filmRate?: number; tvRate?: number }) => {
  const buffer = Buffer.alloc(2048);
  buffer.write(options.big ? 'SDPX' : 'XPDS', 0, 'latin1');
  const u32 = (value: number, at: number) => (options.big ? buffer.writeUInt32BE(value >>> 0, at) : buffer.writeUInt32LE(value >>> 0, at));
  const f32 = (value: number, at: number) => (options.big ? buffer.writeFloatBE(value, at) : buffer.writeFloatLE(value, at));
  u32(options.tc, 1920);
  f32(options.filmRate ?? Number.NaN, 1724);
  f32(options.tvRate ?? Number.NaN, 1940);
  return buffer;
};

/** An OpenEXR header: magic and version, then attributes (name, type, size, value), ending in an empty name. */
const exr = (attributes: { name: string; type: string; value: Buffer }[]) =>
  Buffer.concat([
    Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]),
    ...attributes.flatMap(({ name, type, value }) => {
      const size = Buffer.alloc(4);
      size.writeInt32LE(value.length);
      return [Buffer.from(`${name}\0${type}\0`, 'latin1'), size, value];
    }),
    Buffer.from([0]),
  ]);

/** SMPTE 12M time-and-flags as OpenEXR packs it: frame, seconds, minutes, hours in BCD, drop-frame at bit 6. */
const exrTimecode = (h: number, m: number, s: number, f: number, dropFrame = false) => {
  const value = Buffer.alloc(8);
  const packed = (f % 10) | (Math.floor(f / 10) << 4) | ((dropFrame ? 1 : 0) << 6) | ((s % 10) << 8) | (Math.floor(s / 10) << 12) | ((m % 10) << 16) | (Math.floor(m / 10) << 20) | ((h % 10) << 24) | (Math.floor(h / 10) << 28);
  value.writeUInt32LE(packed >>> 0, 0);
  return value;
};
const rational = (num: number, den: number) => {
  const value = Buffer.alloc(8);
  value.writeInt32LE(num, 0);
  value.writeUInt32LE(den, 4);
  return value;
};

describe('DPX frames', () => {
  it('reads the time code and the film frame rate, in either byte order', async () => {
    for (const big of [true, false]) {
      const path = join(dir, `shot_${big ? 'be' : 'le'}.0001.dpx`);
      await writeFile(path, dpx({ big, tc: 0x01020304, filmRate: 23.976 }));
      expect(await readMediaMeta(path)).toMatchObject({
        ok: true,
        meta: { format: 'DPX', sequence: true, tc: { frames: labelFrames(1, 2, 3, 4, 24, false), base: 24, dropFrame: false }, rate: { num: 24000, den: 1001 } },
      });
    }
  });

  it('falls back to the TV header\'s rate, and reads no timecode when it is unset', async () => {
    const path = join(dir, 'shot.0002.dpx');
    await writeFile(path, dpx({ big: true, tc: 0xffffffff, tvRate: 25 }));
    expect(await readMediaMeta(path)).toMatchObject({ ok: true, meta: { tc: null, rate: { num: 25, den: 1 } } });
  });

  it.skipIf(!ffmpeg)('reads FFmpeg\'s own DPX frames without inventing a timecode from their unset fields', async () => {
    const result = await runFfmpeg(ffmpeg!, ['-y', '-f', 'lavfi', '-i', 'color=c=gray:size=32x18:rate=25', '-frames:v', '1', '-start_number', '7', 'ff_%06d.dpx'], { cwd: dir });
    expect(result.code, result.log).toBe(0);
    expect(await readMediaMeta(join(dir, 'ff_000007.dpx'))).toMatchObject({ ok: true, meta: { format: 'DPX', tc: null } });
  });

  it('refuses what is not a DPX', async () => {
    await writeFile(join(dir, 'fake.0001.dpx'), Buffer.from('nothing here'));
    expect(await readMediaMeta(join(dir, 'fake.0001.dpx'))).toMatchObject({ ok: false });
  });
});

describe('OpenEXR frames', () => {
  it('reads the timeCode and framesPerSecond attributes among the others', async () => {
    const path = join(dir, 'plate.1001.exr');
    await writeFile(
      path,
      exr([
        { name: 'compression', type: 'compression', value: Buffer.from([0]) },
        { name: 'framesPerSecond', type: 'rational', value: rational(30000, 1001) },
        { name: 'timeCode', type: 'timecode', value: exrTimecode(10, 1, 0, 2, true) },
        { name: 'owner', type: 'string', value: Buffer.from('VFX') },
      ]),
    );
    expect(await readMediaMeta(path)).toMatchObject({
      ok: true,
      meta: { format: 'EXR', sequence: true, tc: { frames: labelFrames(10, 1, 0, 2, 30, true), base: 30, dropFrame: true }, rate: { num: 30000, den: 1001 } },
    });
  });

  it.skipIf(!ffmpeg)('reads the rate from FFmpeg\'s own EXR frames, which carry no timecode', async () => {
    const result = await runFfmpeg(ffmpeg!, ['-y', '-f', 'lavfi', '-i', 'color=c=gray:size=32x18:rate=25', '-frames:v', '1', '-c:v', 'exr', '-start_number', '1001', 'ffx.%04d.exr'], { cwd: dir });
    expect(result.code, result.log).toBe(0);
    expect(await readMediaMeta(join(dir, 'ffx.1001.exr'))).toMatchObject({ ok: true, meta: { format: 'EXR', tc: null, rate: { num: 25, den: 1 } } });
  });

  it('says so when the header is cut short', async () => {
    await writeFile(join(dir, 'cut.1001.exr'), Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0, 0x61, 0x62]));
    expect(await readMediaMeta(join(dir, 'cut.1001.exr'))).toMatchObject({ ok: false, error: expect.stringMatching(/cut short/) });
  });
});

describe('rates and patterns', () => {
  it('writes a decimal rate as editors do', () => {
    expect([23.976, 24, 25, 29.97, 59.94, 30].map(rateOfDecimal)).toEqual([
      { num: 24000, den: 1001 },
      { num: 24, den: 1 },
      { num: 25, den: 1 },
      { num: 30000, den: 1001 },
      { num: 60000, den: 1001 },
      { num: 30, den: 1 },
    ]);
    expect([Number.NaN, -1, 0, 1e30].map(rateOfDecimal)).toEqual([null, null, null, null]);
  });

  it('reads a whole sequence from one frame\'s name, keeping its width, case and a % in it', () => {
    expect(sequencePattern('Clip0001_000123.dng')).toEqual({ pattern: 'Clip0001_%06d.dng', start: 123 });
    expect(sequencePattern('plate_v2.1001.EXR')).toEqual({ pattern: 'plate_v2.%04d.EXR', start: 1001 });
    expect(sequencePattern('100%_grey.000001.dpx')).toEqual({ pattern: '100%%_grey.%06d.dpx', start: 1 });
    expect(sequencePattern('A001C001.mov')).toBeNull();
  });
});

describe('dailies from an image sequence', () => {
  const job = (clipPath: string, start: number): RenderJob => ({
    label: '14B-03',
    clip: 'Clip0001',
    clipPath,
    sequence: { start },
    rate: { num: 25, den: 1 },
    durationSec: 1,
    tc: { frames: labelFrames(1, 0, 0, 0, 25, false), base: 25 },
    clipHasAudio: false,
    sound: null,
    look: null,
    circle: false,
    notes: '',
    production: 'HALCYON',
    choice: { codec: 'ProRes 422 Proxy', resolution: '1280 × 720', audio: 'No audio', burnIns: {} },
    font: false,
  });

  it('reads the frames as one clip at the picture\'s rate, from its first frame', () => {
    const { args } = renderArgs(job('/drive/CLIP/Clip0001_%06d.dng', 120), { encoders: new Set(), filters: new Set() });
    expect(args.slice(0, 7)).toEqual(['-y', '-framerate', '25/1', '-start_number', '120', '-i', '/drive/CLIP/Clip0001_%06d.dng']);
  });

  it.skipIf(!ffmpeg)('renders every frame of a DPX and an OpenEXR sequence into a daily', async () => {
    for (const [codec, name] of [
      ['dpx', 'seq_%06d.dpx'],
      ['exr', 'plate.%04d.exr'],
    ] as const) {
      // 25 frames from frame 100, as a camera or a VFX vendor would number them.
      const made = await runFfmpeg(ffmpeg!, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=25', '-frames:v', '25', '-c:v', codec, '-start_number', '100', name], { cwd: dir });
      expect(made.code, made.log).toBe(0);
      const command = renderArgs(job(join(dir, name), 100), ffmpeg as Ffmpeg);
      const output = join(dir, `daily_${codec}.mov`);
      const result = await runFfmpeg(ffmpeg!, [...command.args, output], { cwd: dir });
      expect(result.code, result.log).toBe(0);
      const meta = await readMediaMeta(output);
      expect(meta.ok && meta.meta.durationSec).toBeCloseTo(1, 1);
      expect(meta).toMatchObject({ ok: true, meta: { tc: { frames: labelFrames(1, 0, 0, 0, 25, false), base: 25 } } });
    }
  });
});
