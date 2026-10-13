import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_CDL, applyCdl, applyTable, cubeText, gradeTable, limitCdl, sampleTable, type Cdl, type LookTable } from '../../shared/grade';
import { ProductionDb } from '../db/production-db';
import { locateFfmpeg, runFfmpeg } from '../ffmpeg/ffmpeg';
import { sampleLut } from '../looks/sample';
import { testChart } from '../../renderer/grade/chart';

const wasm = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
const ffmpeg = await locateFfmpeg(null);
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vcdit-grade-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A .cube that swaps red and blue, at 2 points: a look whose effect is unmistakable. */
const SWAP = ['LUT_3D_SIZE 2', '0 0 0', '0 0 1', '0 1 0', '0 1 1', '1 0 0', '1 0 1', '1 1 0', '1 1 1', ''].join('\n');
const WARM: Cdl = { slope: [1.2, 1, 0.8], offset: [0.02, 0, -0.02], power: [0.9, 1, 1.1], sat: 0.7 };

describe('the grade', () => {
  it('holds a grade inside its limits', () => {
    expect(limitCdl({ slope: [9, -1, 1], offset: [1, -1, 0], power: [0, 1, 10], sat: 5 })).toEqual({ slope: [4, 0, 1], offset: [0.5, -0.5, 0], power: [0.25, 1, 4], sat: 2 });
    expect(limitCdl({ slope: [Number.NaN, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 }).slope[0]).toBe(0);
  });

  it('is the CDL alone on LOG, and the CDL then the show LUT over one', () => {
    const swap: LookTable = { size: 2, data: new Float32Array(SWAP.trim().split('\n').slice(1).flatMap((line) => line.split(' ').map(Number))) };
    const rgb: [number, number, number] = [0.6, 0.4, 0.2];
    const onLog = sampleTable(gradeTable(WARM, null), rgb);
    applyCdl(WARM, rgb).forEach((value, i) => expect(onLog[i]).toBeCloseTo(value, 2));
    const over = sampleTable(gradeTable(WARM, swap), rgb);
    const expected = applyCdl(WARM, rgb);
    // Through the swap: red and blue trade places after the grade.
    [expected[2], expected[1], expected[0]].forEach((value, i) => expect(over[i]).toBeCloseTo(value, 2));
  });

  it('leaves a picture as it is with no grade and no LUT', () => {
    const pixels = testChart(64, 32);
    const out = new Uint8ClampedArray(pixels.length);
    applyTable(gradeTable(IDENTITY_CDL, null), pixels, out);
    expect(Math.max(...out.map((value, i) => Math.abs(value - pixels[i]!)))).toBeLessThanOrEqual(1);
  });

  it('writes a .cube with its CDL noted, red fastest', () => {
    const text = cubeText('Warm', gradeTable(IDENTITY_CDL, null, 2), ['ASC CDL warm']);
    expect(text.split('\n').slice(0, 5)).toEqual(['TITLE "Warm"', '# ASC CDL warm', 'LUT_3D_SIZE 2', '0.000000 0.000000 0.000000', expect.stringMatching(/^1\.000000 0\.000000 0\.000000$/)]);
  });
});

describe.skipIf(!ffmpeg)('a show LUT read through FFmpeg', () => {
  it('reads a .cube as the dailies apply it', async () => {
    const table = await sampleLut(ffmpeg!, { format: 'cube', content: SWAP }, 9);
    expect(table.size).toBe(9);
    const out = sampleTable(table, [0.8, 0.5, 0.1]);
    [0.1, 0.5, 0.8].forEach((value, i) => expect(out[i]).toBeCloseTo(value, 2));
  });

  it('refuses what FFmpeg cannot read', async () => {
    await expect(sampleLut(ffmpeg!, { format: 'cube', content: 'LUT_3D_SIZE 2\n0 0 0\n' }, 5)).rejects.toThrow(/could not read this LUT/);
  });

  it('bakes a grade the dailies render as the Grade screen shows it', async () => {
    const swap = await sampleLut(ffmpeg!, { format: 'cube', content: SWAP });
    const cube = cubeText('Warm', gradeTable(WARM, swap));
    await writeFile(join(dir, 'grade.cube'), cube);
    // The test chart, through the baked look by FFmpeg as a daily would be, and by the screen's preview.
    const width = 96;
    const height = 40;
    const chart = testChart(width, height);
    const rgb = Buffer.alloc(width * height * 3);
    for (let p = 0; p < width * height; p += 1) for (let c = 0; c < 3; c += 1) rgb[p * 3 + c] = chart[p * 4 + c]!;
    await writeFile(join(dir, 'chart.rgb'), rgb);
    const result = await runFfmpeg(
      ffmpeg!,
      ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', 'chart.rgb', '-vf', 'lut3d=file=grade.cube:interp=tetrahedral', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'out.rgb'],
      { cwd: dir },
    );
    expect(result.code, result.log).toBe(0);
    const rendered = await readFile(join(dir, 'out.rgb'));
    const preview = new Uint8ClampedArray(chart.length);
    applyTable(gradeTable(WARM, swap), chart, preview);
    let worst = 0;
    for (let p = 0; p < width * height; p += 1) for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(rendered[p * 3 + c]! - preview[p * 4 + c]!));
    expect(worst).toBeLessThanOrEqual(4);
  });
});

describe('grades in the library', () => {
  it('keeps a grade, updates it under its name, and never overwrites an imported LUT', async () => {
    const db = await ProductionDb.open(join(dir, 'p.vcdit'), { wasm, create: { name: 'HALCYON', code: 'HLC' } });
    try {
      const show = db.importLut('HLC_Show.cube', SWAP);
      const id = db.saveGrade('HLC_Day4_Warm', WARM, show, cubeText('HLC_Day4_Warm', gradeTable(WARM, null)), 'ASC CDL over HLC_Show.cube');
      const saved = db.luts().find((lut) => lut.id === id)!;
      expect(saved).toMatchObject({ name: 'HLC_Day4_Warm.cube', cdl: true, sop: WARM, grade: { baseLutId: show }, kind: '3D', size: 33, format: 'cube' });
      // Rules keep pointing at it when it is graded again.
      db.setLutRule('Camera', 'A', id);
      const cooler = { ...WARM, sat: 1 };
      expect(db.saveGrade('HLC_Day4_Warm.cube', cooler, null, cubeText('x', gradeTable(cooler, null)), 'ASC CDL on LOG')).toBe(id);
      expect(db.luts().find((lut) => lut.id === id)).toMatchObject({ sop: cooler, grade: { baseLutId: null }, title: 'ASC CDL on LOG' });
      expect(db.lutFile(id)?.content.startsWith('TITLE "x"')).toBe(true);
      expect(() => db.saveGrade('HLC_Show', WARM, null, 'x', 'x')).toThrow(/imported LUT/);
      expect(() => db.saveGrade('  ', WARM, null, 'x', 'x')).toThrow(/Name the grade/);
      expect(db.luts().find((lut) => lut.id === show)?.grade).toBeUndefined();
      // Its show LUT removed, the grade stays (baked) and says it sits on nothing now.
      db.saveGrade('HLC_Night', WARM, show, 'TITLE "n"\nLUT_3D_SIZE 2\n', 'n');
      db.removeLut(show);
      expect(db.luts().find((lut) => lut.name === 'HLC_Night.cube')?.grade).toEqual({ baseLutId: null });
    } finally {
      await db.close();
    }
  });
});
