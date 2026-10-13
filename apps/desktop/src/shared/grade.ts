/**
 * The on-set grade: an ASC CDL (slope, offset, power per channel, then
 * saturation) over the production's show LUT. A limited grade on purpose:
 * the primaries every colour system reads back exactly, within ranges a set
 * grade stays inside, so what the DP approved on set is what the colourist
 * opens. Shared by the Grade screen (its live preview and scopes) and the
 * main process (the .cube the dailies apply).
 */

export interface Cdl {
  slope: [number, number, number];
  offset: [number, number, number];
  power: [number, number, number];
  sat: number;
}

export const IDENTITY_CDL: Cdl = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 };

/** How far the grade may go: wide enough to balance and shape a shot, not to rebuild it. */
export const GRADE_LIMITS = {
  slope: { min: 0, max: 4 },
  offset: { min: -0.5, max: 0.5 },
  power: { min: 0.25, max: 4 },
  sat: { min: 0, max: 2 },
} as const;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** A CDL held inside the limits, its numbers rounded as the CDL file writes them. */
export const limitCdl = (cdl: Cdl): Cdl => {
  const three = (values: readonly number[], key: 'slope' | 'offset' | 'power', fallback: number) =>
    [0, 1, 2].map((i) => round(clamp(values[i] ?? fallback, GRADE_LIMITS[key].min, GRADE_LIMITS[key].max))) as [number, number, number];
  return {
    slope: three(cdl.slope, 'slope', 1),
    offset: three(cdl.offset, 'offset', 0),
    power: three(cdl.power, 'power', 1),
    sat: round(clamp(cdl.sat, GRADE_LIMITS.sat.min, GRADE_LIMITS.sat.max)),
  };
};

export const isIdentityCdl = (cdl: Cdl): boolean =>
  cdl.slope.every((value) => value === 1) && cdl.offset.every((value) => value === 0) && cdl.power.every((value) => value === 1) && cdl.sat === 1;

/** One colour through the CDL: SOP per channel (clamped before the power), then saturation by Rec. 709 luma. */
export const applyCdl = (cdl: Cdl, rgb: [number, number, number]): [number, number, number] => {
  const sop = rgb.map((value, i) => Math.min(1, Math.max(0, value * cdl.slope[i]! + cdl.offset[i]!)) ** cdl.power[i]!) as [number, number, number];
  const luma = 0.2126 * sop[0] + 0.7152 * sop[1] + 0.0722 * sop[2];
  return sop.map((value) => Math.min(1, Math.max(0, luma + cdl.sat * (value - luma)))) as [number, number, number];
};

/**
 * A 3D look table: `size` points per axis, RGB triplets with red fastest,
 * then green, then blue (the .cube order), values 0–1.
 */
export interface LookTable {
  size: number;
  data: Float32Array;
}

/** A colour through the table, interpolated between its eight nearest points. */
export const sampleTable = (table: LookTable, rgb: readonly [number, number, number]): [number, number, number] => {
  const { size, data } = table;
  const last = size - 1;
  const position = rgb.map((value) => clamp(value, 0, 1) * last);
  const low = position.map((value) => Math.min(last - 1, Math.floor(value)));
  const t = position.map((value, i) => value - low[i]!);
  const out: [number, number, number] = [0, 0, 0];
  for (let corner = 0; corner < 8; corner += 1) {
    const dr = corner & 1;
    const dg = (corner >> 1) & 1;
    const db = (corner >> 2) & 1;
    const weight = (dr ? t[0]! : 1 - t[0]!) * (dg ? t[1]! : 1 - t[1]!) * (db ? t[2]! : 1 - t[2]!);
    if (weight === 0) continue;
    const at = (((low[2]! + db) * size + (low[1]! + dg)) * size + (low[0]! + dr)) * 3;
    out[0] += weight * data[at]!;
    out[1] += weight * data[at + 1]!;
    out[2] += weight * data[at + 2]!;
  }
  return out;
};

/** The grade as one table: the CDL first, then the show LUT under it, as the dailies apply it. */
export const gradeTable = (cdl: Cdl, base: LookTable | null, size = 33): LookTable => {
  const data = new Float32Array(size * size * size * 3);
  let at = 0;
  for (let b = 0; b < size; b += 1)
    for (let g = 0; g < size; g += 1)
      for (let r = 0; r < size; r += 1) {
        const graded = applyCdl(cdl, [r / (size - 1), g / (size - 1), b / (size - 1)]);
        const out = base ? sampleTable(base, graded) : graded;
        data[at] = out[0];
        data[at + 1] = out[1];
        data[at + 2] = out[2];
        at += 3;
      }
  return { size, data };
};

/** The table as a .cube file. */
export const cubeText = (title: string, table: LookTable, comments: string[] = []): string => {
  const lines = [`TITLE "${title.replace(/"/g, "'")}"`, ...comments.map((comment) => `# ${comment}`), `LUT_3D_SIZE ${table.size}`];
  for (let at = 0; at < table.data.length; at += 3) lines.push([0, 1, 2].map((i) => clamp(table.data[at + i]!, 0, 1).toFixed(6)).join(' '));
  return `${lines.join('\n')}\n`;
};

/**
 * 8-bit RGBA pixels through a table, into `out` (the same length). The
 * preview's way: trilinear, as close to the dailies' tetrahedral as an
 * 8-bit preview can show.
 */
export const applyTable = (table: LookTable, pixels: Uint8ClampedArray, out: Uint8ClampedArray): void => {
  const { size, data } = table;
  const last = size - 1;
  const scale = last / 255;
  const row = size * 3;
  const plane = size * size * 3;
  for (let i = 0; i < pixels.length; i += 4) {
    const pr = pixels[i]! * scale;
    const pg = pixels[i + 1]! * scale;
    const pb = pixels[i + 2]! * scale;
    const r0 = Math.min(last - 1, pr | 0);
    const g0 = Math.min(last - 1, pg | 0);
    const b0 = Math.min(last - 1, pb | 0);
    const tr = pr - r0;
    const tg = pg - g0;
    const tb = pb - b0;
    const base = b0 * plane + g0 * row + r0 * 3;
    for (let c = 0; c < 3; c += 1) {
      const a = base + c;
      const c00 = data[a]! + (data[a + 3]! - data[a]!) * tr;
      const c10 = data[a + row]! + (data[a + row + 3]! - data[a + row]!) * tr;
      const c01 = data[a + plane]! + (data[a + plane + 3]! - data[a + plane]!) * tr;
      const c11 = data[a + plane + row]! + (data[a + plane + row + 3]! - data[a + plane + row]!) * tr;
      const c0 = c00 + (c10 - c00) * tg;
      const c1 = c01 + (c11 - c01) * tg;
      out[i + c] = (c0 + (c1 - c0) * tb) * 255;
    }
    out[i + 3] = pixels[i + 3]!;
  }
};
