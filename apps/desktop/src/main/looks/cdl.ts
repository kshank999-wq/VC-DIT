/**
 * ASC CDL looks (ASC Color Decision List v1.2): slope, offset and power per
 * channel, then saturation. The set's grade, as a DIT or DP sets it, in the
 * form every colour system reads.
 *
 * Read from .cc (one correction), .ccc (a collection) and .cdl (a decision
 * list). Each correction becomes a look in the library, kept two ways: the
 * numbers, which go to editorial with each clip (a .ccc, and the ALE's
 * ASC_SOP and ASC_SAT columns), and a 33-point .cube baked from them, which
 * the dailies apply like any other LUT.
 */

import { applyCdl, type Cdl } from '../../shared/grade';

export { applyCdl, type Cdl };

export interface NamedCdl extends Cdl {
  /** The correction's id: often the clip or look name. */
  id: string;
  description: string;
}

export const isCdlFile = (fileName: string): boolean => /\.(cc|ccc|cdl)$/i.test(fileName);

const three = (text: string | undefined, what: string, where: string): [number, number, number] => {
  const values = (text ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) throw new Error(`${where}: ${what} needs three numbers.`);
  return values as [number, number, number];
};

const inner = (block: string, tag: string): string | undefined => new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i').exec(block)?.[1];
const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();

/** Every correction in the file, in order. */
export const parseCdl = (fileName: string, text: string): NamedCdl[] => {
  const blocks = [...text.matchAll(/<(?:\w+:)?ColorCorrection\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?ColorCorrection>/gi)];
  if (blocks.length === 0) throw new Error('No ColorCorrection in it: this is not an ASC CDL.');
  const stem = fileName.replace(/\.[^.]+$/, '');
  return blocks.map((block, index) => {
    const id = decode(/\bid\s*=\s*"([^"]*)"/i.exec(block[1] ?? '')?.[1] ?? '') || (blocks.length === 1 ? stem : `${stem}_${index + 1}`);
    const body = block[2] ?? '';
    const sop = inner(body, 'SOPNode');
    if (!sop) throw new Error(`${id}: no SOPNode (slope, offset, power).`);
    const satNode = inner(body, 'SatNode') ?? inner(body, 'SATNode');
    const sat = satNode === undefined ? 1 : Number((inner(satNode, 'Saturation') ?? '').trim());
    if (!Number.isFinite(sat)) throw new Error(`${id}: Saturation is not a number.`);
    const slope = three(inner(sop, 'Slope'), 'Slope', id);
    const power = three(inner(sop, 'Power'), 'Power', id);
    if (slope.some((value) => value < 0) || power.some((value) => value <= 0) || sat < 0) throw new Error(`${id}: slope and saturation cannot be negative, and power must be above zero.`);
    return {
      id,
      description: decode(inner(body, 'Description') ?? inner(sop, 'Description') ?? ''),
      slope,
      offset: three(inner(sop, 'Offset'), 'Offset', id),
      power,
      sat,
    };
  });
};

/** The CDL baked into a 3D .cube, red fastest, as the dailies apply it. */
export const cdlCube = (cdl: NamedCdl, size = 33): string => {
  const lines = [`TITLE "${cdl.id.replace(/"/g, "'")}"`, `# ASC CDL ${aleSop(cdl)} SAT ${cdl.sat}`, `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b += 1)
    for (let g = 0; g < size; g += 1)
      for (let r = 0; r < size; r += 1) {
        const out = applyCdl(cdl, [r / (size - 1), g / (size - 1), b / (size - 1)]);
        lines.push(out.map((value) => value.toFixed(6)).join(' '));
      }
  return `${lines.join('\n')}\n`;
};

const number = (value: number) => String(Math.round(value * 1e6) / 1e6);
const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The ALE's ASC_SOP: "(s s s)(o o o)(p p p)". */
export const aleSop = (cdl: Cdl): string => `(${cdl.slope.map(number).join(' ')})(${cdl.offset.map(number).join(' ')})(${cdl.power.map(number).join(' ')})`;

/** A ColorCorrectionCollection: one correction per clip, its id the clip's name. */
export const cdlCollection = (items: { id: string; description?: string; cdl: Cdl }[]): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ColorCorrectionCollection xmlns="urn:ASC:CDL:v1.01">',
    ...items.flatMap(({ id, description, cdl }) => [
      `  <ColorCorrection id="${xml(id)}">`,
      ...(description ? [`    <Description>${xml(description)}</Description>`] : []),
      '    <SOPNode>',
      `      <Slope>${cdl.slope.map(number).join(' ')}</Slope>`,
      `      <Offset>${cdl.offset.map(number).join(' ')}</Offset>`,
      `      <Power>${cdl.power.map(number).join(' ')}</Power>`,
      '    </SOPNode>',
      '    <SATNode>',
      `      <Saturation>${number(cdl.sat)}</Saturation>`,
      '    </SATNode>',
      '  </ColorCorrection>',
    ]),
    '</ColorCorrectionCollection>',
    '',
  ].join('\n');
