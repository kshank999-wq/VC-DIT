import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderArgs, timecodeLabel, type RenderJob } from '../dailies/render-args';
import { locateFfmpeg, runFfmpeg, type Ffmpeg } from '../ffmpeg/ffmpeg';
import { parseLut } from '../looks/lut-file';
import { readMediaAudio, readMediaMeta } from '../media/metadata';
import { findOffset } from '../sync/waveform';
import { tintCube } from './fixtures/luts';
// @ts-expect-error a plain JS helper shared with the fixture script
import { burstSignal, RATE, wavBytes } from './fixtures/signal.mjs';


const ffmpeg = await locateFfmpeg(null);
let dir: string;
const fixture = (name: string) => join(__dirname, 'fixtures', name);
const FPS = 24000 / 1001;

const job = (patch: Partial<RenderJob> = {}): RenderJob => ({
  label: '14B-03',
  clip: 'A001C001',
  clipPath: fixture('clip.mov'),
  rate: { num: 24000, den: 1001 },
  durationSec: 2.002,
  tc: { frames: 1217772, base: 24 },
  clipHasAudio: true,
  // The sound file starts 2.5 s (60 frames at 23.976) before the clip.
  sound: { path: '', alignFrames: -2.5 * FPS, channels: 1 },
  look: { name: 'Warm_test.cube', extension: 'cube' },
  circle: true,
  notes: 'Director likes it: "watch focus" 100%',
  production: 'NIGHTJAR',
  choice: { codec: 'ProRes 422 Proxy', resolution: '1280 × 720 · letterbox 2.39', audio: 'Synced · all tracks mixed', burnIns: { TC: true, 'Scene/Take': true, Look: true, Circle: true, Notes: true, 'Clip name': true, Watermark: true } },
  font: true,
  ...patch,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vcdit-dailies-'));
  await writeFile(join(dir, 'sound.wav'), wavBytes(burstSignal(8)));
  await writeFile(join(dir, 'look.cube'), tintCube);
  await copyFile(join(__dirname, '..', '..', '..', 'build', 'fonts', 'IBMPlexMono-Medium.ttf'), join(dir, 'font.ttf'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('LUT files', () => {
  it('accepts a well-formed .cube and says what is wrong with a broken one', () => {
    expect(parseLut('Warm.cube', tintCube)).toEqual({ kind: '3D', size: 2, title: 'Warm test', format: 'cube' });
    expect(() => parseLut('Bad.cube', 'LUT_3D_SIZE 2\n0 0 0\n')).toThrow(/needs 8 rows; this one has 1/);
    expect(() => parseLut('Bad.cube', 'LUT_3D_SIZE 2\nhello world\n')).toThrow(/Line 2/);
    expect(() => parseLut('Look.png', '')).toThrow(/Only \.cube and \.3dl/);
    expect(parseLut('Ramp.cube', 'LUT_1D_SIZE 3\n0 0 0\n0.5 0.5 0.5\n1 1 1\n')).toMatchObject({ kind: '1D', size: 3 });
  });
});

describe('the dailies command', () => {
  it('writes text to files and never into the filter, and says what it cannot do', () => {
    const command = renderArgs(job({ sound: null, font: false }), { encoders: new Set(['prores_ks']), filters: new Set(['lut3d']) });
    expect(command.warnings).toEqual(['No burn-in font found; no burn-ins.', 'No synced sound for this take; the camera scratch audio is used.']);
    const graph = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('lut3d=file=look.cube');
    expect(graph).not.toContain('drawtext');
    expect(() => renderArgs(job({ choice: { ...job().choice, codec: 'H.264 · 10 Mb/s' } }), { encoders: new Set(), filters: new Set() })).toThrow(/no H\.264 encoder/);
    expect(timecodeLabel(1217772, 24)).toBe('14:05:40:12');
  });

  it.skipIf(!ffmpeg)('renders a ProRes daily: the look, burn-ins, the clip timecode, and the production sound in sync', async () => {
    const command = renderArgs(job({ sound: { path: join(dir, 'sound.wav'), alignFrames: -2.5 * FPS, channels: 1 } }), ffmpeg as Ffmpeg);
    expect(command.warnings).toEqual([]);
    for (const [name, content] of Object.entries(command.files)) await writeFile(join(dir, name), content);
    const output = join(dir, '14B-03_A001C001.mov');
    const result = await runFfmpeg(ffmpeg!, [...command.args, output], { cwd: dir });
    expect(result.log && result.code !== 0 ? result.log : '').toBe('');
    expect(result.code).toBe(0);

    const meta = await readMediaMeta(output);
    expect(meta).toEqual({ ok: true, meta: expect.objectContaining({ tc: { frames: 1217772, base: 24, dropFrame: false }, rate: { num: 24000, den: 1001 }, hasAudio: true }) });
    expect(meta.ok && meta.meta.durationSec).toBeCloseTo(2.0, 1);
    // The daily's sound is the production sound from 2.5 s in: the same as the camera heard.
    const daily = await readMediaAudio(output, { startSec: 0, seconds: 30 });
    const scratch = await readMediaAudio(fixture('clip.mov'), { startSec: 0, seconds: 30 });
    expect(Math.abs(findOffset(daily, { samples: scratch.samples, sampleRate: scratch.sampleRate })!.offsetSec)).toBeLessThan(0.01);
    expect((await readFile(output)).includes(Buffer.from('look: Warm_test.cube'))).toBe(true);
    expect((await stat(output)).size).toBeGreaterThan(10_000);
  });

  it.skipIf(!ffmpeg)('renders H.264 and DNxHR too', async () => {
    for (const codec of ['DNxHR LB', 'H.264 · 10 Mb/s']) {
      const command = renderArgs(job({ sound: null, choice: { ...job().choice, codec, audio: 'Camera scratch only' } }), ffmpeg as Ffmpeg);
      for (const [name, content] of Object.entries(command.files)) await writeFile(join(dir, name), content);
      const output = join(dir, `out.${command.extension}`);
      const result = await runFfmpeg(ffmpeg!, [...command.args, output], { cwd: dir });
      expect(result.code, result.log).toBe(0);
      expect((await stat(output)).size).toBeGreaterThan(10_000);
    }
  });
});
