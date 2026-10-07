import { timecodeLabel } from '../dailies/render-args';
import type { EditorialRow } from '../db/production-db';

/**
 * What editorial gets besides the media (spec §4.10 "Editorial handoff"):
 * an Avid Log Exchange (ALE) of the day's camera clips with their scene,
 * take, timecode, sound and look, and the same as a CSV for other edit
 * systems and for people. Made from the production database only.
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

const takeName = (row: EditorialRow) => (row.take ? `${row.scene}${row.setup}-${row.take.padStart(2, '0')}` : row.clip);

const span = (row: EditorialRow): { start: string; end: string } => {
  if (!row.tc) return { start: '', end: '' };
  const fps = row.rate ? row.rate.num / row.rate.den : row.tc.base;
  // ALE's End is the frame after the last, as Avid writes it.
  const frames = row.durationSec !== null ? Math.round(row.durationSec * fps) : 0;
  return {
    start: timecodeLabel(row.tc.frames, row.tc.base),
    end: timecodeLabel(row.tc.frames + frames, row.tc.base),
  };
};

const offset = (frames: number | null) => (frames === null ? '' : `${frames >= 0 ? '+' : ''}${Math.round(frames * 100) / 100}`);

export const editorialAle = (rows: EditorialRow[], frameRate: string): string => {
  const fps = rateLabel(rows.find((row) => row.rate)?.rate ?? null) ?? (/[\d.]+/.exec(frameRate)?.[0] || '23.976');
  const columns = [
    'Name',
    'Tracks',
    'Start',
    'End',
    'Tape',
    'Source File',
    'Scene',
    'Take',
    'Camroll',
    'Soundroll',
    'Audio File',
    'Sync Method',
    'Sync Offset',
    'Circled',
    'LUT',
    'Comments',
  ];
  const data = rows.map((row) => {
    const { start, end } = span(row);
    return [
      takeName(row),
      row.soundFile ? 'VA1A2' : 'V',
      start,
      end,
      row.clip,
      row.file,
      row.scene,
      row.take,
      row.roll,
      row.soundRoll,
      row.soundFile,
      row.sync,
      offset(row.syncFrames),
      row.circle ? 'Yes' : '',
      row.look,
      row.notes,
    ]
      .map(cell)
      .join('\t');
  });
  return [
    'Heading',
    'FIELD_DELIM\tTABS',
    'VIDEO_FORMAT\t1080',
    'AUDIO_FORMAT\t48khz',
    `FPS\t${fps}`,
    '',
    'Column',
    columns.join('\t'),
    '',
    'Data',
    ...data,
    '',
  ].join('\n');
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
