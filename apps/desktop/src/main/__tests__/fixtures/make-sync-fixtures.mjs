// Builds clip.mov and clip.mxf: a 2-second camera clip at 23.976 fps,
// timecode 14:05:40:12, whose scratch audio is seconds 2.5–4.5 of the test
// sound. And clip-ltc.mov: 2 seconds at 25 fps with no timecode of its own,
// microphone sound on the left channel and LTC from a sync box on the right,
// 10:00:00:00 starting 0.3 of a frame before the clip.
// Run once with ffmpeg on the PATH: node make-sync-fixtures.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { burstSignal, ltcSignal, RATE, stereoWavBytes, wavBytes } from './signal.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'vcdit-fixtures-'));
const scratch = join(work, 'scratch.wav');
writeFileSync(scratch, wavBytes(burstSignal(8).subarray(2.5 * RATE, 4.5 * RATE)));
const common = ['-y', '-f', 'lavfi', '-i', 'color=c=gray:size=64x36:rate=24000/1001', '-i', scratch, '-t', '2', '-timecode', '14:05:40:12', '-map', '0:v', '-map', '1:a'];
execFileSync('ffmpeg', [...common, '-c:v', 'mjpeg', '-q:v', '31', '-c:a', 'pcm_s24le', join(here, 'clip.mov')], { stdio: 'inherit' });
execFileSync('ffmpeg', [...common, '-c:v', 'mpeg2video', '-b:v', '200k', '-c:a', 'pcm_s24le', '-f', 'mxf', join(here, 'clip.mxf')], { stdio: 'inherit' });
const ltc = join(work, 'ltc.wav');
writeFileSync(ltc, stereoWavBytes(burstSignal(2, 11), ltcSignal({ h: 10, m: 0, s: 0, f: 0 }, 25, 2, { phase: 0.3 })));
execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=gray:size=32x18:rate=25', '-i', ltc, '-t', '2', '-map', '0:v', '-map', '1:a', '-c:v', 'mjpeg', '-q:v', '31', '-c:a', 'pcm_s16le', join(here, 'clip-ltc.mov')], { stdio: 'inherit' });
rmSync(work, { recursive: true });
