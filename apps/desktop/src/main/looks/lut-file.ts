/**
 * Production LUTs (spec §4.7): checked on import, so a broken file is turned
 * away at the library rather than discovered in the dailies. Adobe/Resolve
 * .cube (1D or 3D) and Lustre/Flame .3dl are read; both are what FFmpeg's
 * lut3d filter applies.
 */

export interface LutInfo {
  kind: '1D' | '3D';
  /** Points per axis (3D) or entries (1D). */
  size: number;
  title: string;
  format: 'cube' | '3dl';
}

export const parseLut = (fileName: string, text: string): LutInfo => {
  const extension = fileName.toLowerCase().split('.').pop();
  if (extension === 'cube') return parseCube(text);
  if (extension === '3dl') return parse3dl(text);
  throw new Error('Only .cube and .3dl LUTs can be imported.');
};

const parseCube = (text: string): LutInfo => {
  let title = '';
  let size3 = 0;
  let size1 = 0;
  let values = 0;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^TITLE\b/i.test(line)) title = line.replace(/^TITLE\s*/i, '').replace(/^"|"$/g, '');
    else if (/^LUT_3D_SIZE\b/i.test(line)) size3 = Number(line.split(/\s+/)[1]);
    else if (/^LUT_1D_SIZE\b/i.test(line)) size1 = Number(line.split(/\s+/)[1]);
    else if (/^(DOMAIN_MIN|DOMAIN_MAX|LUT_3D_INPUT_RANGE|LUT_1D_INPUT_RANGE)\b/i.test(line)) continue;
    else if (/^[-+\d.eE]+\s+[-+\d.eE]+\s+[-+\d.eE]+$/.test(line)) {
      if (line.split(/\s+/).some((value) => !Number.isFinite(Number(value)))) throw new Error(`Line ${index + 1}: "${line}" is not three numbers.`);
      values += 1;
    } else throw new Error(`Line ${index + 1}: "${line.slice(0, 40)}" is not part of a .cube LUT.`);
  }
  if (size3) {
    if (size3 < 2 || size3 > 256) throw new Error(`LUT_3D_SIZE ${size3} is out of range.`);
    if (values !== size3 ** 3) throw new Error(`A ${size3}-point 3D LUT needs ${size3 ** 3} rows; this one has ${values}.`);
    return { kind: '3D', size: size3, title, format: 'cube' };
  }
  if (size1) {
    if (values !== size1) throw new Error(`A ${size1}-entry 1D LUT needs ${size1} rows; this one has ${values}.`);
    return { kind: '1D', size: size1, title, format: 'cube' };
  }
  throw new Error('No LUT_3D_SIZE or LUT_1D_SIZE: this is not a .cube LUT.');
};

const parse3dl = (text: string): LutInfo => {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !/^(Mesh|LUT8|gamma)\b/i.test(line));
  // The first row lists the input points (e.g. 17 values), the rest are R G B triplets.
  const shaper = rows[0]?.split(/\s+/).length ?? 0;
  const triplets = rows.slice(1).filter((line) => /^\d+\s+\d+\s+\d+$/.test(line)).length;
  if (shaper < 2 || triplets !== shaper ** 3) throw new Error('This .3dl does not have the rows its first line promises.');
  return { kind: '3D', size: shaper, title: '', format: '3dl' };
};
