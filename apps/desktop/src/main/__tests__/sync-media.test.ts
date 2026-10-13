import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMediaAudio, readMediaMeta } from '../media/metadata';
import { bars, findOffset } from '../sync/waveform';
// @ts-expect-error a plain JS helper shared with the fixture script
import { burstSignal, RATE, wavBytes } from './fixtures/signal.mjs';

/**
 * The readers against real files: clip.mov and clip.mxf were made by ffmpeg
 * (fixtures/make-sync-fixtures.mjs): 2 s at 23.976 fps, timecode 14:05:40:12,
 * scratch audio = seconds 2.5–4.5 of the test sound.
 */

const fixture = (name: string) => join(__dirname, 'fixtures', name);
let dir: string;
let wav: string;
// The production sound starts 2.5 s before the clip: 14:05:38:00 at 23.976 (60 TC frames = 2.5025 s earlier).
const SOUND_START_SEC = (((14 * 60 + 5) * 60 + 38) * 24) / (24000 / 1001);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vcdit-sync-'));
  wav = join(dir, '14B-03.WAV');
  const ixml = '<BWFXML><SCENE>14B</SCENE><TAKE>3</TAKE><TAPE>D14</TAPE><TIMECODE_RATE>24000/1001</TIMECODE_RATE><TRACK_LIST><TRACK><NAME>Boom</NAME></TRACK></TRACK_LIST></BWFXML>';
  await writeFile(wav, wavBytes(burstSignal(8), { timeReference: Math.round(SOUND_START_SEC * RATE), ixml }));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('reading media headers', () => {
  it('reads timecode, rate, length and scratch audio from a QuickTime clip', async () => {
    expect(await readMediaMeta(fixture('clip.mov'))).toEqual({
      ok: true,
      meta: expect.objectContaining({
        kind: 'picture',
        format: 'QuickTime',
        tc: { frames: ((14 * 60 + 5) * 60 + 40) * 24 + 12, base: 24, dropFrame: false },
        rate: { num: 24000, den: 1001 },
        sampleRate: 48000,
        channels: 1,
        hasAudio: true,
      }),
    });
  });

  it('reads the same from an MXF clip', async () => {
    const result = await readMediaMeta(fixture('clip.mxf'));
    expect(result).toEqual({
      ok: true,
      meta: expect.objectContaining({ kind: 'picture', format: 'MXF', tc: { frames: 1217772, base: 24, dropFrame: false }, rate: { num: 24000, den: 1001 }, hasAudio: true }),
    });
    expect(result.ok && result.meta.durationSec).toBeCloseTo(2.002, 3);
  });

  it("reads a Broadcast WAV's start time and the recorder's iXML", async () => {
    const result = await readMediaMeta(wav);
    expect(result).toEqual({
      ok: true,
      meta: expect.objectContaining({
        kind: 'sound',
        sampleRate: 48000,
        channels: 1,
        durationSec: 8,
        ixml: { scene: '14B', take: '3', tape: 'D14', rate: '24000/1001', tracks: ['Boom'] },
      }),
    });
    expect(result.ok && result.meta.soundStartSec).toBeCloseTo(SOUND_START_SEC, 4);
  });

  it('says plainly what it cannot read', async () => {
    expect(await readMediaMeta(join(dir, 'A001_C001.R3D'))).toEqual({ ok: false, error: expect.stringMatching(/RED SDK/) });
    expect(await readMediaMeta(join(dir, 'missing.mov'))).toEqual({ ok: false, error: expect.stringMatching(/Could not open/) });
    await writeFile(join(dir, 'fake.mov'), 'not a movie');
    expect(await readMediaMeta(join(dir, 'fake.mov'))).toEqual({ ok: false, error: expect.stringMatching(/movie header/) });
  });
});

describe('waveform sync', () => {
  it("finds where each clip's scratch audio sits in the production sound, to the millisecond", async () => {
    const sound = await readMediaAudio(wav, { startSec: 0, seconds: 600 });
    for (const name of ['clip.mov', 'clip.mxf']) {
      const clip = await readMediaAudio(fixture(name), { startSec: 0, seconds: 30 });
      expect(clip.samples.length).toBeGreaterThanOrEqual(95_000);
      const match = findOffset(clip, sound)!;
      expect(match.offsetSec).toBeCloseTo(2.5, 2);
      expect(match.confidence).toBeGreaterThan(60);
      expect(match.confidence).toBeLessThan(90);
    }
  });

  it('does not claim a match between unrelated sounds', async () => {
    const clip = await readMediaAudio(fixture('clip.mov'), { startSec: 0, seconds: 30 });
    const other = { samples: burstSignal(8, 99), sampleRate: RATE };
    expect(findOffset(clip, other)?.confidence ?? 0).toBeLessThanOrEqual(40);
  });

  it('draws loudness as bars', () => {
    const drawn = bars(burstSignal(2), 40);
    expect(drawn).toHaveLength(40);
    expect(Math.max(...drawn)).toBe(100);
    expect(Math.min(...drawn)).toBeGreaterThanOrEqual(0);
  });
});
