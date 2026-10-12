/** @vitest-environment jsdom */
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProductionDb, type EditorialRow } from '../db/production-db';
import { editorialAle } from '../delivery/editorial';
import { editorialCdl, editorialFcpxml, editorialXmeml } from '../delivery/editorial-xml';
import { aleSop, applyCdl, cdlCollection, cdlCube, parseCdl } from '../looks/cdl';
import { parseLut } from '../looks/lut-file';

const wasm = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');

const CCC = `<?xml version="1.0" encoding="UTF-8"?>
<ColorCorrectionCollection xmlns="urn:ASC:CDL:v1.01">
  <ColorCorrection id="EXT_DAY">
    <Description>Exterior day &amp; warm</Description>
    <SOPNode><Slope>1.1 1.0 0.9</Slope><Offset>0.01 0 -0.02</Offset><Power>1 1 1.05</Power></SOPNode>
    <SatNode><Saturation>0.9</Saturation></SatNode>
  </ColorCorrection>
  <ColorCorrection id="INT_NIGHT">
    <SOPNode><Slope>0.8 0.8 0.9</Slope><Offset>0 0 0</Offset><Power>1.1 1.1 1.0</Power></SOPNode>
  </ColorCorrection>
</ColorCorrectionCollection>`;

const RAID = '/Volumes/RAID/HALCYON/SHOOT_DAY_014_2026-10-07';
const SHTL = '/Volumes/SHTL/HALCYON/SHOOT_DAY_014_2026-10-07';
const row = (patch: Partial<EditorialRow> = {}): EditorialRow => ({
  clip: 'A015C002',
  card: 'A015',
  file: 'A015C002_261007_R1AB.mov',
  tc: { frames: 1217772, base: 24 },
  rate: { num: 24000, den: 1001 },
  durationSec: 10.01,
  scene: '14',
  setup: 'B',
  take: '3',
  circle: true,
  notes: 'great & <loud>',
  roll: 'A015',
  soundRoll: 'S004',
  soundFile: '14B-03.WAV',
  sync: 'Timecode',
  syncFrames: -12.4,
  look: 'EXT_DAY.cc',
  cdl: { slope: [1.1, 1, 0.9], offset: [0.01, 0, -0.02], power: [1, 1, 1.05], sat: 0.9 },
  paths: [`${RAID}/CAMERA_ORIGINALS/A015/A015C002_261007_R1AB.mov`, `${SHTL}/CAMERA_ORIGINALS/A015/A015C002_261007_R1AB.mov`],
  soundPaths: [`${RAID}/SOUND_ORIGINALS/S004/14B-03.WAV`, `${SHTL}/SOUND_ORIGINALS/S004/14B-03.WAV`],
  soundChannels: 4,
  sampleRate: 48000,
  soundStartSec: 50739,
  soundDurationSec: 14.5,
  ...patch,
});
const unsynced = row({ clip: 'B007C001', file: 'B007C001.mov', card: 'B007', scene: '', setup: '', take: '', circle: false, tc: null, sync: 'None', syncFrames: null, soundFile: '', soundPaths: [], cdl: null, look: '', notes: '', paths: [`${RAID}/CAMERA_ORIGINALS/B007/B007C001.mov`] });

/** The little of jsdom's DOM these tests read (the main process is built without DOM types). */
interface Node {
  textContent: string | null;
  children: ArrayLike<Node>;
  getAttribute(name: string): string | null;
  querySelector(selector: string): Node | null;
  querySelectorAll(selector: string): ArrayLike<Node> & Iterable<Node>;
  getElementsByTagName(name: string): ArrayLike<Node>;
}
const { DOMParser } = globalThis as unknown as { DOMParser: new () => { parseFromString(text: string, type: string): Node } };

const parse = (text: string) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return doc;
};

describe('ASC CDL looks', () => {
  it('reads every correction in a collection, with saturation 1 when none is given', () => {
    const looks = parseCdl('show.ccc', CCC);
    expect(looks.map((look) => [look.id, look.description, look.slope, look.sat])).toEqual([
      ['EXT_DAY', 'Exterior day & warm', [1.1, 1, 0.9], 0.9],
      ['INT_NIGHT', '', [0.8, 0.8, 0.9], 1],
    ]);
    // A single .cc without an id takes the file's name.
    expect(parseCdl('A015_grade.cc', '<ColorCorrection><SOPNode><Slope>1 1 1</Slope><Offset>0 0 0</Offset><Power>1 1 1</Power></SOPNode></ColorCorrection>')[0]!.id).toBe('A015_grade');
  });

  it('refuses what is not a CDL, or numbers that cannot be one', () => {
    expect(() => parseCdl('x.cc', '<nope/>')).toThrow(/not an ASC CDL/);
    expect(() => parseCdl('x.cc', '<ColorCorrection id="A"><SOPNode><Slope>1 1</Slope><Offset>0 0 0</Offset><Power>1 1 1</Power></SOPNode></ColorCorrection>')).toThrow(/A: Slope needs three numbers/);
    expect(() => parseCdl('x.cc', '<ColorCorrection id="A"><SOPNode><Slope>1 1 1</Slope><Offset>0 0 0</Offset><Power>0 1 1</Power></SOPNode></ColorCorrection>')).toThrow(/power must be above zero/);
  });

  it('applies slope, offset and power, clamped, then saturation by Rec. 709 luma', () => {
    const identity = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 } as const;
    expect(applyCdl({ ...identity, slope: [...identity.slope], offset: [...identity.offset], power: [...identity.power] }, [0.25, 0.5, 0.75])).toEqual([0.25, 0.5, 0.75]);
    const [r, g, b] = applyCdl({ slope: [2, 1, 1], offset: [0, 0, -0.5], power: [1, 2, 1], sat: 1 }, [0.4, 0.5, 0.25]);
    expect([r, g, b].map((value) => Math.round(value * 1e6) / 1e6)).toEqual([0.8, 0.25, 0]);
    // No saturation: every channel is the luma.
    const grey = applyCdl({ slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 0 }, [1, 0, 0]);
    expect(grey.map((value) => Math.round(value * 1e4) / 1e4)).toEqual([0.2126, 0.2126, 0.2126]);
  });

  it('bakes into a 33-point .cube the dailies apply, and writes back out for editorial', () => {
    const look = parseCdl('show.ccc', CCC)[0]!;
    const cube = cdlCube(look);
    expect(parseLut('EXT_DAY.cube', cube)).toEqual({ kind: '3D', size: 33, title: 'EXT_DAY', format: 'cube' });
    expect(aleSop(look)).toBe('(1.1 1 0.9)(0.01 0 -0.02)(1 1 1.05)');
    const again = parseCdl('out.ccc', cdlCollection([{ id: 'A015C002', description: 'EXT_DAY', cdl: look }]))[0]!;
    expect(again).toMatchObject({ id: 'A015C002', description: 'EXT_DAY', slope: look.slope, offset: look.offset, power: look.power, sat: 0.9 });
  });

  it('becomes a look in the library, one per correction, marked as a CDL', async () => {
    const base = await mkdtemp(join(tmpdir(), 'vcdit-cdl-'));
    const db = await ProductionDb.open(join(base, 'p.vcdit'), { wasm, create: { name: 'HALCYON', code: 'HLC' } });
    try {
      db.importLut('show.ccc', CCC);
      expect(db.luts().map((lut) => [lut.name, lut.title, lut.format, lut.size, lut.cdl])).toEqual([
        ['EXT_DAY.cc', 'Exterior day & warm', 'cube', 33, true],
        ['INT_NIGHT.cc', 'INT_NIGHT', 'cube', 33, true],
      ]);
      // The same file again is fine; a different one under the same name is not.
      db.importLut('show.ccc', CCC);
      expect(() => db.importLut('show.ccc', CCC.replace('1.1 1.0 0.9', '1.2 1.0 0.9'))).toThrow(/A different EXT_DAY.cc is already in the library/);
    } finally {
      await db.close();
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('editorial XML', () => {
  it('writes FCPXML with the day as an event, linked to the copies on the drive written to, sound synced below picture', () => {
    const text = editorialFcpxml([row(), unsynced], { frameRate: '23.976 fps', event: 'HALCYON · Day 14', root: '/Volumes/SHTL' });
    const doc = parse(text);
    expect(doc.querySelector('fcpxml')!.getAttribute('version')).toBe('1.10');
    expect(doc.querySelector('format')!.getAttribute('frameDuration')).toBe('1001/24000s');
    expect(doc.querySelector('event')!.getAttribute('name')).toBe('HALCYON · Day 14');
    const sources = [...doc.querySelectorAll('media-rep')].map((rep) => rep.getAttribute('src'));
    expect(sources).toEqual([
      `file://${SHTL}/CAMERA_ORIGINALS/A015/A015C002_261007_R1AB.mov`,
      `file://${SHTL}/SOUND_ORIGINALS/S004/14B-03.WAV`,
      // Not on the shuttle: its first copy.
      `file://${RAID}/CAMERA_ORIGINALS/B007/B007C001.mov`,
    ]);
    const synced = doc.querySelector('sync-clip')!;
    expect(synced.getAttribute('name')).toBe('14B-03');
    const start = 1217772;
    expect(synced.getAttribute('start')).toBe(`${start * 1001}/24000s`);
    // Sound starts 12 frames before picture: it is placed at picture's first frame, 12 frames in.
    const sound = synced.querySelector('asset-clip[lane="-1"]')!;
    const soundStart = Math.round(50739 * (24000 / 1001));
    expect(sound.getAttribute('offset')).toBe(`${start * 1001}/24000s`);
    expect(sound.getAttribute('start')).toBe(`${(soundStart + 12) * 1001}/24000s`);
    expect([...synced.querySelectorAll('keyword')].map((k) => k.getAttribute('value'))).toEqual(['Circled', 'Look EXT_DAY.cc']);
    expect(synced.querySelector('note')!.textContent).toBe('great & <loud>');
    expect(synced.querySelector('md[key="com.apple.proapps.studio.scene"]')!.getAttribute('value')).toBe('14');
    // A clip with no sound and no timecode is a plain clip, named by the clip.
    const plain = doc.querySelector('event > asset-clip')!;
    expect([plain.getAttribute('name'), plain.getAttribute('start')]).toEqual(['B007C001', '0s']);
  });

  it('writes Final Cut Pro 7 XML for Premiere: bins by scene, merged clips lined up by the sync offset', () => {
    const doc = parse(editorialXmeml([row(), unsynced], { frameRate: '23.976 fps', bin: 'HALCYON · Day 14', root: '/Volumes/RAID' }));
    expect(doc.querySelector('xmeml')!.getAttribute('version')).toBe('4');
    expect([...doc.querySelectorAll('xmeml > bin > children > bin > name')].map((n) => n.textContent)).toEqual(['Scene 14', 'No scene']);
    const clip = doc.querySelector('clip')!;
    expect(clip.querySelector('name')!.textContent).toBe('14B-03');
    expect(clip.querySelector('rate ntsc')!.textContent).toBe('TRUE');
    expect(clip.querySelector('video file pathurl')!.textContent).toBe(`file://${RAID}/CAMERA_ORIGINALS/A015/A015C002_261007_R1AB.mov`);
    expect(clip.querySelector('video file timecode string')!.textContent).toBe('14:05:40:12');
    // Four channels of sound, one track each, all from the one file, starting 12 frames into it.
    const tracks = [...clip.querySelectorAll('audio > track > clipitem')];
    expect(tracks).toHaveLength(4);
    expect(tracks.map((item) => item.querySelector('sourcetrack trackindex')!.textContent)).toEqual(['1', '2', '3', '4']);
    expect([tracks[0]!.querySelector('start')!.textContent, tracks[0]!.querySelector('in')!.textContent]).toEqual(['0', '12']);
    expect(tracks[0]!.querySelector('file pathurl')!.textContent).toBe(`file://${RAID}/SOUND_ORIGINALS/S004/14B-03.WAV`);
    expect(tracks[1]!.querySelector('file')!.children).toHaveLength(0);
    expect(clip.querySelector('logginginfo good')!.textContent).toBe('TRUE');
    expect(clip.querySelector('mastercomment4')!.textContent).toBe('ASC_SOP (1.1 1 0.9)(0.01 0 -0.02)(1 1 1.05) ASC_SAT 0.9');
  });

  it('writes each clip\'s CDL, and the ALE carries it too', () => {
    expect(editorialCdl([unsynced])).toBeNull();
    const ccc = editorialCdl([row(), unsynced])!;
    expect(parseCdl('day.ccc', ccc).map((look) => look.id)).toEqual(['A015C002']);
    const ale = editorialAle([row(), unsynced], '23.976 fps').split('\n');
    const columns = ale[ale.indexOf('Column') + 1]!.split('\t');
    const first = ale[ale.indexOf('Data') + 1]!.split('\t');
    expect(first[columns.indexOf('ASC_SOP')]).toBe('(1.1 1 0.9)(0.01 0 -0.02)(1 1 1.05)');
    expect(first[columns.indexOf('ASC_SAT')]).toBe('0.9');
  });
});
