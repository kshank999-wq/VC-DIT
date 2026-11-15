import { timecodeLabel } from '../dailies/render-args';
import type { EditorialRow } from '../db/production-db';
import { aleSop } from '../looks/cdl';

/**
 * What editorial gets besides the media (spec §4.10 "Editorial handoff"):
 * an Avid Log Exchange (ALE) of the day's camera clips with their scene,
 * take, timecode, sound and look, and the same as a CSV for other edit
 * systems and for people. Made from the production database only.
 *
 * ONE ALE (Ken, 15 November 2026): these are the editorial files editorial
 * uses, since only VC DIT has the media and the synced sound. VC Smart Slate
 * and VC Film Studio make the same layout for when VC DIT's are not there
 * yet: the columns below are theirs, in their order
 * (vc-smart-slate SlateCore/Export/Editorial.swift `aleColumns`,
 * vc_film_studio lib/export/takes-interchange.ts `ALE_COLUMNS`), then the
 * sound columns only VC DIT can fill. A clip is named by slate and camera,
 * "14B-03 A", so two cameras on one take never share a name; its camera
 * file is its Tape and Source File.
 */

const RATES: [number, string][] = [
  [23.976, '23.976'],
  [24, '24'],
  [25, '25'],
  [29.97, '29.97'],
  [30, '30'],
  [47.952, '47.952'],
  [48, '48'],
  [50, '50'],
  [59.94, '59.94'],
  [60, '60'],
];

/** "23.976" for 24000/1001: the way ALE and editors write rates. */
export const rateLabel = (rate: { num: number; den: number } | null): string | null => {
  if (!rate || rate.den === 0) return null;
  const fps = rate.num / rate.den;
  return RATES.find(([value]) => Math.abs(value - fps) < 0.01)?.[1] ?? String(Math.round(fps * 1000) / 1000);
};

/** One cell: no tabs or line breaks, which would break the columns. */
const cell = (value: string) => value.replace(/[\t\r\n]+/g, ' ').trim();

/** The take number as the slate and Film Studio write it: two digits, "03". */
export const takeNumber = (row: EditorialRow) => (row.take ? row.take.padStart(2, '0') : '');

/** "14B-03 A": scene and setup, take, camera; a clip matched to no take keeps the camera's name for it. */
export const takeName = (row: EditorialRow) => (row.take ? `${row.scene}${row.setup}-${takeNumber(row)}${row.camera ? ` ${row.camera}` : ''}` : row.clip);

/** The standard ALE columns: the slate's and Film Studio's, in their order, then the sound. */
export const ALE_COLUMNS = [
  'Name', 'Tracks', 'Start', 'End', 'Tape', 'Source File', 'Card File', 'Scene', 'Take', 'Camera', 'Camroll', 'Soundroll',
  'Lens', 'Circled', 'Shoot Date', 'Shoot Day', 'Look', 'ASC_SOP', 'ASC_SAT', 'Description', 'Comments', 'Slate', 'TC From',
  'Audio File', 'Sync Method', 'Sync Offset',
] as const;

const span = (row: EditorialRow): { start: string; end: string } => {
  if (!row.tc) return { start: '', end: '' };
  const fps = row.rate ? row.rate.num / row.rate.den : row.tc.base;
  // ALE's End is the frame after the last, as Avid writes it.
  const frames = row.durationSec !== null ? Math.round(row.durationSec * fps) : 0;
  return {
    start: timecodeLabel(row.tc.frames, row.tc.base, row.tc.dropFrame),
    end: timecodeLabel(row.tc.frames + frames, row.tc.base, row.tc.dropFrame),
  };
};

const offset = (frames: number | null) => (frames === null ? '' : `${frames >= 0 ? '+' : ''}${Math.round(frames * 100) / 100}`);

/** Tab-delimited, CRLF, the three sections Media Composer reads. End is exclusive: the first frame after the clip. */
export const editorialAle = (rows: EditorialRow[], frameRate: string, day: { number: number; date: string } | null = null): string => {
  const fps = rateLabel(rows.find((row) => row.rate)?.rate ?? null) ?? (/[\d.]+/.exec(frameRate)?.[0] || '23.976');
  const data = rows.map((row) => {
    const { start, end } = span(row);
    const fields: Record<(typeof ALE_COLUMNS)[number], string> = {
      Name: takeName(row),
      Tracks: row.soundFile ? 'VA1A2' : 'V',
      Start: start,
      End: end,
      Tape: row.clip,
      'Source File': row.file,
      'Card File': row.cardFile,
      Scene: row.scene,
      Take: takeNumber(row),
      Camera: row.camera,
      Camroll: row.roll,
      Soundroll: row.soundRoll,
      Lens: row.lens,
      Circled: row.circle ? 'Y' : '',
      'Shoot Date': day?.date ?? '',
      'Shoot Day': day ? String(day.number) : '',
      Look: row.look,
      ASC_SOP: row.cdl ? aleSop(row.cdl) : '',
      ASC_SAT: row.cdl ? String(row.cdl.sat) : '',
      Description: row.description,
      Comments: row.notes,
      /* The running slate number is the slate's; VC DIT's log does not carry it. */
      Slate: '',
      /* Read off the media itself: the camera clip's own start. */
      'TC From': row.tc ? 'camera clip' : 'none',
      'Audio File': row.soundFile,
      'Sync Method': row.sync,
      'Sync Offset': offset(row.syncFrames),
    };
    return ALE_COLUMNS.map((column) => cell(fields[column])).join('\t');
  });
  return [
    'Heading',
    'FIELD_DELIM\tTABS',
    'VIDEO_FORMAT\t1080',
    'AUDIO_FORMAT\t48khz',
    `FPS\t${fps}`,
    '',
    'Column',
    ALE_COLUMNS.join('\t'),
    '',
    'Data',
    ...data,
    '',
  ].join('\r\n');
};

const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export const editorialCsv = (rows: EditorialRow[]): string => {
  const header = [
    'clip',
    'card',
    'file',
    'scene',
    'setup',
    'take',
    'circled',
    'tc_start',
    'tc_end',
    'fps',
    'sound_roll',
    'sound_file',
    'sync',
    'sync_offset_frames',
    'look',
    'notes',
  ];
  const body = rows.map((row) => {
    const { start, end } = span(row);
    return [
      row.clip,
      row.card,
      row.file,
      row.scene,
      row.setup,
      row.take,
      row.circle ? 'yes' : 'no',
      start,
      end,
      rateLabel(row.rate) ?? '',
      row.soundRoll,
      row.soundFile,
      row.sync,
      offset(row.syncFrames),
      row.look,
      row.notes,
    ].map(csvCell);
  });
  return `${[header, ...body].map((row) => row.join(',')).join('\n')}\n`;
};
