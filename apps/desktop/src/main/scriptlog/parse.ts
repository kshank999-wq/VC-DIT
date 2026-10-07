import { parseXml, type XmlElement } from './xml';

/**
 * The script supervisor's log, read into one neutral shape (spec §4.5) from
 * the formats their tools export: CSV or tab-separated text (any column
 * order, a title row or two above the header is fine), Avid ALE, JSON and
 * XML. Columns are recognised by name, so a log needs no particular
 * template; what a row cannot say is left empty, never guessed.
 */

export interface LogEntry {
  /** Row (CSV, ALE) or record number (JSON, XML), for messages. */
  line: number;
  scene: string;
  setup: string;
  /** The take number, digits only: "4". */
  take: string;
  /** Scene and setup as written, before they were split: "14B". */
  slate: string;
  /** Camera letters this row is for, when given. */
  cameras: string[];
  /** Camera clip names as written: "A015C002". */
  clipRefs: string[];
  roll: string;
  soundRoll: string;
  soundRef: string;
  tcIn: string;
  tcOut: string;
  circle: boolean;
  print: boolean;
  vfx: boolean;
  vfxNote: string;
  notes: string;
  lens: string;
  description: string;
}

export type LogFormat = 'CSV' | 'Tab-separated' | 'ALE' | 'JSON' | 'XML';

export interface ParsedLog {
  format: LogFormat;
  entries: LogEntry[];
  /** Rows skipped or values not understood, with where they were. */
  warnings: string[];
}

type Field = keyof Omit<LogEntry, 'line' | 'cameras' | 'clipRefs' | 'circle' | 'print' | 'vfx'> | 'camera' | 'clip' | 'circle' | 'print' | 'vfx';

/** Column names each field is known by, compared as lowercase letters and digits. */
const ALIASES: Record<Field, string[]> = {
  scene: ['scene', 'sc', 'scn', 'sceneno', 'scenenumber', 'scenenum'],
  setup: ['setup', 'shot', 'angle', 'setupletter', 'setupno', 'shotletter'],
  slate: ['slate', 'slateno', 'slatenumber', 'scenesetup', 'scenetake'],
  take: ['take', 'tk', 'takeno', 'takenumber', 'takenum'],
  camera: ['camera', 'cam', 'cameraletter', 'unit'],
  clip: ['clip', 'clipname', 'clipid', 'clips', 'cameraclip', 'cameraclipname', 'name', 'clipnames', 'filename', 'mediafile'],
  roll: ['roll', 'reel', 'camroll', 'cameraroll', 'camerareel', 'mag', 'card', 'tape', 'camerafile'],
  soundRoll: ['soundroll', 'soundreel', 'audioroll', 'soundcard'],
  soundRef: ['soundfile', 'audiofile', 'soundclip', 'soundname', 'wav', 'audio', 'soundfilename'],
  tcIn: ['tcin', 'starttc', 'start', 'timecodein', 'tc', 'timecode', 'intc', 'recordtcin', 'starttimecode', 'tcstart'],
  tcOut: ['tcout', 'endtc', 'end', 'timecodeout', 'outtc', 'recordtcout', 'endtimecode', 'tcend'],
  circle: ['circle', 'circled', 'circletake', 'select', 'selected', 'selects', 'good', 'circletk'],
  print: ['print', 'printed', 'printtake'],
  vfx: ['vfx', 'vfxshot', 'isvfx', 'fx', 'visualeffects'],
  vfxNote: ['vfxnote', 'vfxnotes', 'vfxdescription', 'vfxcomments'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks', 'scriptnotes', 'editorialnotes'],
  lens: ['lens', 'focallength', 'mm', 'lenses'],
  description: ['description', 'scenedescription', 'slugline', 'set', 'setdescription'],
};

const squash = (header: string) =>
  header
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const LOOKUP = new Map<string, Field>(Object.entries(ALIASES).flatMap(([field, names]) => names.map((name) => [name, field as Field] as const)));
export const fieldOf = (header: string): Field | null => LOOKUP.get(squash(header)) ?? null;

const TRUE = new Set(['y', 'yes', 'true', '1', 'x', '✓', '✔', '●', '◎', 'o', 'c', 'circle', 'circled', 'select', 'selected', 'print', 'vfx', '*']);
const NO = /^\s*(n|no|false|0|n\/a|na|none|-|—)\s*$/i;
const yes = (value: string | undefined) => (value ? TRUE.has(value.trim().toLowerCase()) : false);

const TIMECODE = /^(\d{1,2})[:;.](\d{2})[:;.](\d{2})(?:[:;.](\d{2,3}))?$/;
const timecode = (value: string) => {
  const found = TIMECODE.exec(value.trim());
  return found ? [found[1]!.padStart(2, '0'), found[2], found[3], found[4] ?? '00'].join(':') : '';
};

const split = (value: string) =>
  value
    .split(/[,;/|&+]|\s{2,}|\s+and\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);

/** One record (a row, an object, an element) into an entry; null when it names no take. */
const toEntry = (values: Map<Field, string>, line: number, warnings: string[]): LogEntry | null => {
  const get = (field: Field) => values.get(field)?.trim() ?? '';
  let scene = get('scene');
  let setup = get('setup');
  let slate = get('slate');
  let takeText = get('take');

  // A slate column, or a scene column holding the whole slate ("14B", "14B-4", "14B/T4").
  const slated = /^(\d+)\s*([A-Z]{0,3})(?:\s*[-/_.\s]\s*T?\s*(\d+))?$/i;
  const whole = slate || (!setup ? scene : '');
  const parts = whole ? slated.exec(whole) : null;
  if (parts) {
    scene = parts[1]!;
    setup ||= parts[2]!.toUpperCase();
    takeText ||= parts[3] ?? '';
  }
  slate = whole || `${scene}${setup}`;

  // "4", "T4", "Tk 04", "4*" or "(4)" — a star or brackets are how some logs circle a take.
  const take = /^\s*(?:t(?:ake|k)?\s*)?\(?\s*0*(\d+)\s*\)?\s*([*◎●]|c\b)?/i.exec(takeText);
  const clipRefs = split(get('clip'));
  if (!scene || !take) {
    if ([...values.values()].some((value) => value.trim())) {
      warnings.push(`Line ${line}: no ${!scene ? 'scene' : 'take number'} — skipped.`);
    }
    return null;
  }
  const marked = Boolean(take[2]) || /^\s*\(.*\)\s*$/.test(takeText);
  const vfxNote = get('vfxNote');
  const tcIn = timecode(get('tcIn'));
  if (get('tcIn') && !tcIn) warnings.push(`Line ${line}: timecode "${get('tcIn')}" not understood — left out.`);
  return {
    line,
    scene: scene.toUpperCase(),
    setup: setup.toUpperCase(),
    take: take[1]!,
    slate: slate.toUpperCase(),
    cameras: split(get('camera')).map((camera) => camera.toUpperCase().slice(0, 2)),
    clipRefs,
    roll: get('roll'),
    soundRoll: get('soundRoll'),
    soundRef: get('soundRef'),
    tcIn,
    tcOut: timecode(get('tcOut')),
    circle: yes(get('circle')) || marked,
    print: yes(get('print')),
    // A VFX column may hold a yes, or the VFX note itself ("Sky replacement").
    vfx: yes(get('vfx')) || (Boolean(get('vfx')) && !NO.test(get('vfx'))) || Boolean(vfxNote),
    vfxNote: vfxNote || (get('vfx').length > 3 && !yes(get('vfx')) && !NO.test(get('vfx')) ? get('vfx') : ''),
    notes: get('notes'),
    lens: get('lens'),
    description: get('description'),
  };
};

// ---------------------------------------------------------------- delimited text

/** RFC 4180 rows: quoted fields may hold the delimiter, quotes ("") and line breaks. */
const rowsOf = (text: string, delimiter: string): { cells: string[]; line: number }[] => {
  const rows: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else if (char === '\r' && text[i + 1] === '\n') continue;
      else {
        if (char === '\n') line += 1;
        cell += char;
      }
    } else if (char === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (char === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      cells.push(cell);
      rows.push({ cells, line: start });
      cells = [];
      cell = '';
      line += 1;
      start = line;
    } else cell += char;
  }
  if (cell || cells.length) {
    cells.push(cell);
    rows.push({ cells, line: start });
  }
  return rows;
};

const fromRows = (rows: { cells: string[]; line: number }[], warnings: string[]): LogEntry[] => {
  // The header is the first row naming a take or slate and at least one other field.
  const headerAt = rows.findIndex(({ cells }) => {
    const fields = cells.map(fieldOf);
    return (fields.includes('take') || fields.includes('slate') || fields.includes('clip')) && fields.filter(Boolean).length >= 2;
  });
  if (headerAt < 0) throw new Error('No header row found. The log needs columns named like Scene, Setup, Take (and ideally Clip or Roll, Circle, VFX, Notes).');
  const fields = rows[headerAt]!.cells.map(fieldOf);
  const entries: LogEntry[] = [];
  for (const { cells, line } of rows.slice(headerAt + 1)) {
    if (cells.every((cell) => !cell.trim())) continue;
    const values = new Map<Field, string>();
    cells.forEach((cell, index) => {
      const field = fields[index];
      if (field && cell.trim() && !values.has(field)) values.set(field, cell);
    });
    const entry = toEntry(values, line, warnings);
    if (entry) entries.push(entry);
  }
  return entries;
};

const parseAle = (text: string, warnings: string[]): LogEntry[] => {
  const lines = text.split(/\r?\n/);
  const columnAt = lines.findIndex((line) => line.trim() === 'Column');
  const dataAt = lines.findIndex((line) => line.trim() === 'Data');
  if (columnAt < 0 || dataAt < 0) throw new Error('This ALE has no Column or Data section.');
  const header = lines.slice(columnAt + 1).find((line) => line.trim()) ?? '';
  const rows = lines.slice(dataAt + 1).map((line, index) => ({ cells: line.split('\t'), line: dataAt + 2 + index }));
  return fromRows([{ cells: header.split('\t'), line: columnAt + 2 }, ...rows], warnings);
};

// ---------------------------------------------------------------- structured

/** An object's fields, one level of nesting flattened ("timecode": {"in"} → "timecodein"). */
const flatten = (value: Record<string, unknown>, prefix = ''): Map<Field, string> => {
  const out = new Map<Field, string>();
  for (const [key, item] of Object.entries(value)) {
    const name = `${prefix}${key}`;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const [field, text] of flatten(item as Record<string, unknown>, name)) if (!out.has(field)) out.set(field, text);
      continue;
    }
    const field = fieldOf(name) ?? (prefix ? fieldOf(key) : null);
    if (!field || out.has(field) || item === null || item === undefined) continue;
    out.set(field, Array.isArray(item) ? item.map(String).join(', ') : typeof item === 'boolean' ? (item ? 'yes' : 'no') : String(item));
  }
  return out;
};

const parseJson = (text: string, warnings: string[]): LogEntry[] => {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Not valid JSON: ${(cause as Error).message}`);
  }
  const records = Array.isArray(data)
    ? data
    : (Object.values((data ?? {}) as Record<string, unknown>).find(
        (value) => Array.isArray(value) && value.some((item) => item && typeof item === 'object'),
      ) as unknown[] | undefined);
  if (!records) throw new Error('No list of takes found in this JSON.');
  return records.flatMap((record, index) => {
    if (!record || typeof record !== 'object') return [];
    const entry = toEntry(flatten(record as Record<string, unknown>), index + 1, warnings);
    return entry ? [entry] : [];
  });
};

const xmlValues = (element: XmlElement): Map<Field, string> => {
  const out = new Map<Field, string>();
  const put = (name: string, value: string) => {
    const field = fieldOf(name);
    if (field && value.trim() && !out.has(field)) out.set(field, value.trim());
  };
  for (const [name, value] of Object.entries(element.attributes)) put(name, value);
  for (const child of element.children) {
    if (child.children.length === 0) put(child.name, child.text);
    else for (const grandchild of child.children) put(`${child.name}${grandchild.name}`, grandchild.text);
  }
  return out;
};

const parseXmlLog = (text: string, warnings: string[]): LogEntry[] => {
  const all: XmlElement[] = [];
  const walk = (element: XmlElement) => {
    for (const child of element.children) {
      all.push(child);
      walk(child);
    }
  };
  walk(parseXml(text));
  // The records are the element kind that most often names a take.
  const counts = new Map<string, number>();
  for (const element of all) {
    const values = xmlValues(element);
    if (values.has('take') || values.has('slate')) counts.set(element.name, (counts.get(element.name) ?? 0) + 1);
  }
  const name = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!name) throw new Error('No takes found in this XML (elements with a take or slate).');
  return all
    .filter((element) => element.name === name)
    .flatMap((element, index) => {
      const entry = toEntry(xmlValues(element), index + 1, warnings);
      return entry ? [entry] : [];
    });
};

// ---------------------------------------------------------------- the entry point

const delimiterOf = (text: string): string => {
  const sample = text.split(/\r?\n/).slice(0, 20).join('\n');
  const count = (char: string) => sample.split(char).length - 1;
  return [',', '\t', ';'].sort((a, b) => count(b) - count(a))[0]!;
};

export const parseScriptLog = (fileName: string, input: string | Uint8Array): ParsedLog => {
  const bytes = typeof input === 'string' ? null : input;
  if (bytes && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    throw new Error('This looks like an Excel workbook. In Excel, use File → Save As → CSV, and import the CSV.');
  }
  const text = (typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input)).replace(/^﻿/, '');
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  const warnings: string[] = [];
  const trimmed = text.trimStart();

  let format: LogFormat;
  let entries: LogEntry[];
  if (extension === 'ale' || /^Heading\s*$/m.test(text.slice(0, 200))) {
    format = 'ALE';
    entries = parseAle(text, warnings);
  } else if (extension === 'json' || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    format = 'JSON';
    entries = parseJson(text, warnings);
  } else if (extension === 'xml' || trimmed.startsWith('<')) {
    format = 'XML';
    entries = parseXmlLog(text, warnings);
  } else {
    const delimiter = extension === 'tsv' || extension === 'tab' ? '\t' : delimiterOf(text);
    format = delimiter === '\t' ? 'Tab-separated' : 'CSV';
    entries = fromRows(rowsOf(text, delimiter), warnings);
  }
  if (entries.length === 0) throw new Error('No takes found in this log.');
  return { format, entries, warnings };
};

/** A CSV with every column the importer knows, for script supervisors without an export of their own. */
export const LOG_TEMPLATE = [
  'Scene,Setup,Take,Camera,Clip,Roll,Sound Roll,Sound File,TC In,TC Out,Circle,VFX,VFX Notes,Lens,Notes',
  '14,A,1,A,A015C001,A015,S014,14A-01,14:02:11:00,14:03:02:12,,,,21mm,',
  '14,A,2,A,A015C002,A015,S014,14A-02,14:05:40:08,14:06:31:20,Y,,,21mm,Director likes this one',
  '14,B,1,"A, B","A015C003, B010C001",A015,S014,14B-01,14:20:01:00,14:21:10:00,,Y,Sky replacement,40mm,',
  '',
].join('\n');
