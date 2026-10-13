import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LookTable } from '../../shared/grade';
import { runFfmpeg, type Ffmpeg } from '../ffmpeg/ffmpeg';

/**
 * A library LUT as a table the Grade screen can apply live and a grade can
 * be baked over: every point of a lattice run through FFmpeg's own lut3d,
 * the filter the dailies use, so a .cube, a .3dl or a 1D LUT reads exactly
 * as it renders.
 */
export const sampleLut = async (ffmpeg: Ffmpeg, look: { format: 'cube' | '3dl'; content: string }, size = 33): Promise<LookTable> => {
  if (!ffmpeg.filters.has('lut3d')) throw new Error('This FFmpeg has no lut3d filter, so looks cannot be previewed.');
  const width = size * size;
  const identity = Buffer.alloc(width * size * 6);
  const level = (index: number) => Math.round((index / (size - 1)) * 65535);
  // One row per blue step; across it red runs fastest, then green.
  for (let b = 0; b < size; b += 1)
    for (let g = 0; g < size; g += 1)
      for (let r = 0; r < size; r += 1) {
        const at = ((b * size + g) * size + r) * 6;
        identity.writeUInt16LE(level(r), at);
        identity.writeUInt16LE(level(g), at + 2);
        identity.writeUInt16LE(level(b), at + 4);
      }
  const work = await mkdtemp(join(tmpdir(), 'vcdit-lut-'));
  try {
    await writeFile(join(work, 'lattice.rgb'), identity);
    await writeFile(join(work, `look.${look.format}`), look.content, 'utf8');
    const result = await runFfmpeg(
      ffmpeg,
      ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-s', `${width}x${size}`, '-i', 'lattice.rgb', '-vf', `lut3d=file=look.${look.format}:interp=tetrahedral`, '-f', 'rawvideo', '-pix_fmt', 'rgb48le', 'out.rgb'],
      { cwd: work },
    );
    if (result.code !== 0) throw new Error(`FFmpeg could not read this LUT: ${result.log.trim().split('\n').pop() ?? ''}`);
    const out = await readFile(join(work, 'out.rgb'));
    if (out.length !== identity.length) throw new Error('FFmpeg returned a LUT of the wrong size.');
    const data = new Float32Array(size * size * size * 3);
    for (let i = 0; i < data.length; i += 1) data[i] = out.readUInt16LE(i * 2) / 65535;
    return { size, data };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};
