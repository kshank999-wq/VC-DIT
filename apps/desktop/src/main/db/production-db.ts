import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import type { ChecksumMethod } from '../../shared/media';
import {
  DEFAULT_NAMING,
  FORMAT_RULES,
  MIRROR_METHODS,
  type FormatRule,
  localDate,
  type MirrorMethod,
  type Production,
  type ProjectState,
  type SceneEntry,
  type SceneStatus,
  type ShootDay,
  type VfxEntry,
  type VfxLocation,
} from '../../shared/project';
import type { FileOutcome, SourceFile } from '../media/transfer';
import type { SealExpected } from '../media/seal';
import type { RelinkFound, RelinkLeg } from '../media/relink';
import { matchDay, type Candidate, type DayClip } from '../scriptlog/match';
import type { LogEntry, ParsedLog } from '../scriptlog/parse';
import { clipKeyOfFile, isPictureFile, pictureKey, sequenceOf } from '../scriptlog/clip-key';
import { buildLogView, candidateLabel, type StoredEntry, type StoredImport, type StoredMatch, type VfxFlag } from '../scriptlog/view';
import type { MirrorFile, MirrorOutcome, MirrorPlan } from '../vfx/mirror';
import type { MediaMeta, MetaResult } from '../media/metadata';
import {
  DEFAULT_DAILIES,
  LUT_SCOPES,
  type DailiesSettings,
  type DailyRender,
  type LutEntry,
  type LutRuleEntry,
  type LutScope,
  type SyncEntry,
} from '../../shared/project';
import { parseLut } from '../looks/lut-file';
import { cdlCube, isCdlFile, parseCdl, type Cdl } from '../looks/cdl';
import type { ViewClip } from '../organize/view';
import { SCENE_VIEW, SELECTS_VIEW, applyNaming } from '../../shared/project';
import { segment } from '../media/rules';
import { resolveAssignment, reportClipKey, SOURCE_WORD, splitSlate, takeNumber, type Assignment, type Claim } from '../organize/assign';
import type { AssignedClip, CameraReportInput, CameraReportRow, DriveSeal, FrameioTarget, MatchEntry, SetupEntry, SlateInput, TakesState } from '../../shared/project';
import {
  DEFAULT_DELIVERY,
  DELIVERY_PACKAGES,
  type DayNote,
  type NoteInput,
  type DeliveryPackageId,
  type DeliveryRecord,
  type DeliverySettings,
} from '../../shared/project';

/**
 * One production's database: a single SQLite file on the cart (spec §2
 * "the media index"), so on set it needs no connection, and the whole
 * production can be copied, archived or handed over as one file.
 *
 * SQLite runs as WebAssembly (sql.js), so there is no native module to build
 * for each platform. The database lives in memory and is written back to its
 * file half a second after a change: to a temporary file first, then renamed
 * over the old one, so a crash mid-write never leaves a broken database.
 * Opening a file also keeps the previous version as `<file>.bak`.
 */

export interface TransferRecord {
  id: string;
  day: number;
  card: string;
  label: string;
  sourceRoot: string;
  sound: boolean;
  checksum: ChecksumMethod;
  startedAt: string | null;
  finishedAt: string | null;
  /** When the card's ingested files were erased so it could go back to camera. */
  clearedAt?: string | null;
  files: (SourceFile & { hash: string | null; hashedAt: string | null })[];
  destinations: {
    id: string;
    name: string;
    root: string;
    targetDir: string;
    reportsDir: string;
    error: string | null;
    outcomes: Record<string, FileOutcome>;
    /** Fed from a backup (relayFrom, a leg id) rather than the card. */
    relay?: boolean;
    relayFrom?: string | null;
    /** A drive on the cart rather than the network: fed from the backup, it is a cascade copy, not an upload. */
    local?: boolean;
    /** An LTO tape: written in a tape run. */
    tape?: boolean;
  }[];
}

/** Each entry moves the schema one version on; never edit one that has shipped. */
const MIGRATIONS: string[] = [
  `
  create table production (
    id integer primary key check (id = 1),
    name text not null,
    code text not null,
    frame_rate text not null,
    checksum text not null,
    total_days integer not null,
    devices text not null default '[]',
    naming_tokens text not null default '[]',
    current_day integer not null default 1,
    created_at text not null,
    updated_at text not null
  );

  create table shoot_day (
    number integer primary key,
    date text not null,
    locations text not null default '',
    operator_name text not null default '',
    operator_initials text not null default '',
    created_at text not null
  );

  -- The day's scene list (spec §4.1), in the order it was entered.
  create table scene (
    day integer not null,
    id text not null,
    description text not null default '',
    status text not null default 'Scheduled',
    notes text not null default '',
    look text not null default '',
    position integer not null,
    primary key (day, id)
  );

  -- One card's ingest (spec "Transfer Record").
  create table transfer (
    id text not null,
    day integer not null,
    card text not null,
    label text not null,
    source_root text not null,
    sound integer not null,
    checksum text not null,
    started_at text,
    finished_at text,
    primary key (day, id)
  );

  create table transfer_destination (
    day integer not null,
    transfer_id text not null,
    leg_id text not null,
    position integer not null,
    name text not null,
    root text not null,
    target_dir text not null,
    reports_dir text not null,
    error text,
    primary key (day, transfer_id, leg_id)
  );

  -- Every file of every card (spec "Clip / Audio File"): its original name and
  -- path on the card, and the checksum it was copied with.
  create table clip (
    id integer primary key,
    day integer not null,
    transfer_id text not null,
    card text not null,
    path text not null,
    file_name text not null,
    kind text not null check (kind in ('camera', 'sound')),
    size integer not null,
    mtime_ms real not null,
    checksum_method text not null,
    checksum text,
    hashed_at text,
    unique (day, transfer_id, path)
  );

  -- Where each clip was copied, and whether that copy verified.
  create table clip_copy (
    clip_id integer not null,
    leg_id text not null,
    state text not null check (state in ('verified', 'already-there', 'failed')),
    error text,
    primary key (clip_id, leg_id)
  );

  create index clip_card_idx on clip (day, card);
  create index clip_name_idx on clip (file_name);
  `,
  `
  -- The day's script supervisor log (spec §4.5): the last file imported,
  -- its rows, and how each row's clips were matched.
  create table script_import (
    day integer primary key,
    file_name text not null,
    format text not null,
    imported_at text not null,
    warnings text not null default '[]'
  );

  create table script_entry (
    id integer primary key,
    day integer not null,
    position integer not null,
    scene text not null,
    setup text not null,
    take text not null,
    slate text not null,
    cameras text not null,
    clip_refs text not null,
    roll text not null,
    sound_roll text not null,
    sound_ref text not null,
    tc_in text not null,
    tc_out text not null,
    circle integer not null,
    print integer not null,
    vfx integer not null,
    vfx_note text not null,
    notes text not null,
    lens text not null,
    description text not null
  );
  create index script_entry_day_idx on script_entry (day, position);

  -- One row per camera clip a log row names (or per camera, when it names none).
  create table script_match (
    entry_id integer not null,
    ref_index integer not null,
    ref text not null,
    camera text not null,
    state text not null check (state in ('matched', 'review', 'unmatched')),
    clip_key text,
    clip_card text,
    candidates text not null default '[]',
    reason text not null default '',
    decided text not null default 'auto' check (decided in ('auto', 'dit', 'wild')),
    primary key (entry_id, ref_index)
  );

  create table script_sound (
    entry_id integer primary key,
    clip_key text not null,
    clip_card text not null
  );

  -- The DIT's decisions, kept by what the row says rather than by row, so
  -- they survive importing an updated log; a corrected row is decided afresh.
  create table script_decision (
    day integer not null,
    entry_key text not null,
    ref_index integer not null,
    clip_key text,
    clip_card text,
    primary key (day, entry_key, ref_index)
  );
  `,
];

const MIGRATION_3 = `
  -- VFX (spec §4.9): how shots are mirrored, shots the DIT tagged, each
  -- destination's mirror of each shot, and what was handed to VC VFX Prep.
  alter table production add column vfx_method text not null default 'Hard link';

  create table vfx_tag (
    day integer not null,
    scene text not null,
    setup text not null,
    take text not null,
    clip_key text not null,
    card text not null,
    note text not null default '',
    created_at text not null,
    primary key (day, card, clip_key)
  );

  create table vfx_mirror (
    day integer not null,
    shot_key text not null,
    leg_id text not null,
    destination text not null,
    method text not null,
    target_dir text not null,
    state text not null check (state in ('mirrored', 'failed')),
    error text,
    made_at text not null,
    primary key (day, shot_key, leg_id)
  );

  create table vfx_handoff (
    day integer not null,
    shot_key text not null,
    sent_at text not null,
    package text not null,
    primary key (day, shot_key)
  );
`;
// Kept beside the code that reads it; appended, so the order of versions never changes.
MIGRATIONS.push(MIGRATION_3);

const MIGRATION_4 = `
  -- Sync (spec §4.6): what each media file's header says (timecode, rate,
  -- length, start of recording), and each camera clip's sync with sound.
  alter table clip add column meta text;

  create table sync_record (
    day integer not null,
    card text not null,
    clip_key text not null,
    sound_card text,
    sound_key text,
    method text not null check (method in ('Timecode', 'Waveform', 'Manual', 'None')),
    -- Where the sound file starts relative to the clip's first frame, in frames; and the method's own answer.
    align_frames real,
    base_frames real,
    fps real,
    confidence integer not null,
    why text not null default '',
    accepted integer not null default 0,
    decided text not null default 'auto' check (decided in ('auto', 'dit')),
    bars_picture text not null default '[]',
    bars_sound text not null default '[]',
    made_at text not null,
    primary key (day, card, clip_key)
  );
`;
MIGRATIONS.push(MIGRATION_4);

const MIGRATION_5 = `
  -- Looks (spec §4.7): the production's LUTs, kept whole in the database so
  -- the production file carries them, and the rules that assign them.
  create table lut (
    id integer primary key,
    name text not null unique,
    format text not null,
    kind text not null,
    size integer not null,
    title text not null default '',
    content text not null,
    imported_at text not null
  );

  create table lut_rule (
    id integer primary key,
    scope text not null check (scope in ('Project', 'Camera', 'Day', 'Scene', 'Setup', 'Clip')),
    target text not null,
    lut_id integer not null,
    unique (scope, target)
  );

  -- Dailies (spec §4.8): the settings last used, and every daily rendered.
  alter table production add column dailies text;

  create table dailies_render (
    day integer not null,
    take_id text not null,
    clip_key text not null,
    card text not null,
    label text not null,
    output text not null,
    state text not null check (state in ('done', 'failed')),
    error text,
    lut text,
    codec text not null,
    bytes integer,
    checksum text,
    warnings text not null default '[]',
    made_at text not null,
    primary key (day, take_id, clip_key)
  );
`;
MIGRATIONS.push(MIGRATION_5);

const MIGRATION_6 = `
  -- Delivery (spec §4.10): the choices and presets, and each package's
  -- delivery to each destination, with the files that did not verify so
  -- they alone can be tried again.
  alter table production add column delivery text;

  create table delivery_record (
    day integer not null,
    package text not null,
    leg_id text not null,
    destination text not null,
    root text not null,
    source text not null,
    files integer not null,
    bytes integer not null,
    verified integer not null,
    already_there integer not null,
    failed integer not null,
    retries integer not null default 0,
    started_at text not null,
    finished_at text not null,
    problems text not null default '[]',
    failed_files text not null default '[]',
    mhl text,
    primary key (day, package, leg_id)
  );
`;
MIGRATIONS.push(MIGRATION_6);

const MIGRATION_7 = `
  -- The scene view (spec §4.4): where each clip appears by scene/setup/take
  -- (and each circle take among the selects) on each destination, so it can
  -- follow the log and be taken down when a clip moves.
  create table organize_link (
    day integer not null,
    kind text not null check (kind in ('scene', 'select')),
    card text not null,
    clip_key text not null,
    leg_id text not null,
    destination text not null,
    rel_dir text not null,
    target_dir text not null,
    card_dir text not null,
    method text not null,
    state text not null check (state in ('placed', 'failed')),
    error text,
    made_at text not null,
    primary key (day, kind, card, clip_key, leg_id)
  );
`;
MIGRATIONS.push(MIGRATION_7);

// The shoot day's notes (spec §6 "Shoot Day: notes"); superseded by day_note below.
MIGRATIONS.push(`alter table shoot_day add column notes text not null default '';`);

// Timecoded notes through the day; a day's earlier free-text notes become its first general note.
MIGRATIONS.push(`
  create table day_note (
    id integer primary key,
    day integer not null,
    tc text,
    tc_source text not null check (tc_source in ('ltc', 'free-run', 'jam', 'clock', 'none')),
    rate text not null default '',
    at text not null,
    scope text not null check (scope in ('general', 'shot')),
    scene text not null default '',
    setup text not null default '',
    take text not null default '',
    clip text not null default '',
    body text not null,
    screen text not null default ''
  );
  create index day_note_day_idx on day_note (day, at);
  insert into day_note (day, tc, tc_source, at, scope, body)
    select number, null, 'none', created_at, 'general', notes from shoot_day where trim(notes) != '';
`);

// Relay uploads (spec §4.3.1): a destination fed from a backup, and which; the production's rule for when a card is safe to format.
MIGRATIONS.push(`
  alter table transfer_destination add column relay integer not null default 0;
  alter table transfer_destination add column relay_from text;
  alter table production add column format_rule text not null default 'two-local';
`);

// A card cleared for camera after a fresh check (spec §8): when.
MIGRATIONS.push(`alter table transfer add column cleared_at text;`);

// Where clips go besides the script log (spec §4.4, §4.5): the camera report, and the DIT's own word.
MIGRATIONS.push(`
  create table camera_report (
    id integer primary key,
    day integer not null,
    card text not null,
    clip text not null,
    scene text not null,
    setup text not null default '',
    take text not null,
    circle integer not null default 0,
    lens text not null default '',
    notes text not null default '',
    source text not null default 'entered' check (source in ('entered', 'csv', 'film-studio')),
    position integer not null
  );
  create index camera_report_day_idx on camera_report (day, card, position);

  -- The DIT's assignment of a clip (manual), a choice between sources that disagreed (decided), or "goes nowhere" (none).
  create table clip_assign (
    day integer not null,
    card text not null,
    clip_key text not null,
    scene text not null default '',
    setup text not null default '',
    take text not null default '',
    circle integer not null default 0,
    how text not null check (how in ('manual', 'decided', 'none')),
    made_at text not null,
    primary key (day, card, clip_key)
  );
`);

// Drives sealed before they leave set: when, how thoroughly, and the manifest written to them.
MIGRATIONS.push(`
  create table drive_seal (
    id integer primary key,
    root text not null,
    name text not null,
    sealed_at text not null,
    files integer not null,
    bytes integer not null,
    verified integer not null,
    manifest text
  );
`);

// An ASC CDL look keeps its numbers (slope, offset, power, saturation) for editorial, beside the .cube baked from them.
MIGRATIONS.push(`alter table lut add column cdl text;`);

// Cascade copies (spec §4.3.1): whether a destination is a drive on the cart, so a copy to it from the backup runs beside the uploads.
MIGRATIONS.push(`alter table transfer_destination add column local integer;`);

// Renaming on offload (spec §4.4): a renamed clip's name on the card, beside the name its copies have; and the production's choice.
MIGRATIONS.push(`
  alter table clip add column source_path text;
  alter table production add column rename_clips integer not null default 0;
`);

// LTO tape (spec §4.3.4): a destination written in tape runs, not card by card.
MIGRATIONS.push(`alter table transfer_destination add column tape integer not null default 0;`);

// The Grade screen: a look made there is a CDL over a show LUT; it keeps which one, to be opened and graded again.
MIGRATIONS.push(`
  alter table lut add column grade integer not null default 0;
  alter table lut add column grade_base integer;
`);

// Frame.io (spec §4.8): where the production publishes its dailies, and each daily published there.
MIGRATIONS.push(`
  alter table production add column frameio text;
  create table frameio_upload (
    day integer not null,
    take_id text not null,
    clip_key text not null,
    project_id text not null,
    file_id text,
    name text not null,
    bytes integer not null,
    checksum text,
    state text not null check (state in ('done', 'failed')),
    error text,
    view_url text,
    at text not null,
    primary key (day, take_id, clip_key)
  );
`);

/** One clip in the scene view or the selects, and every destination holding its verified copy. */
export interface OrganizeView extends ViewClip {
  kind: 'scene' | 'select';
  /** Under the day folder: CAMERA_ORIGINALS/_BY_SCENE/SCENE_014/SETUP_B/NJR_D014_SC14B_T03_A015. */
  relDir: string;
  locations: { legId: string; name: string; root: string; cardDir: string }[];
}

export interface OrganizeLink {
  kind: 'scene' | 'select';
  card: string;
  clip: string;
  legId: string;
  destination: string;
  relDir: string;
  targetDir: string;
  cardDir: string;
  method: string;
  state: 'placed' | 'failed';
  error: string | null;
}

/** A file a delivery could not verify: enough to try it alone again. */
export interface DeliveryFile {
  /** The day folder it was read from. */
  root: string;
  path: string;
  size: number;
  mtimeMs: number;
  expected: string | null;
}

export type StoredDelivery = DeliveryRecord & { root: string; failedFiles: DeliveryFile[] };

/** One camera clip as editorial gets it in the ALE. */
export interface EditorialRow {
  clip: string;
  card: string;
  file: string;
  tc: { frames: number; base: number; dropFrame?: boolean } | null;
  rate: { num: number; den: number } | null;
  durationSec: number | null;
  scene: string;
  setup: string;
  take: string;
  circle: boolean;
  notes: string;
  roll: string;
  soundRoll: string;
  soundFile: string;
  sync: string;
  /** Where the sound starts relative to the clip's first frame, in frames. */
  syncFrames: number | null;
  look: string;
  /** The look's ASC CDL, when it is one. */
  cdl: Cdl | null;
  /** Every verified copy of the camera file, absolute. */
  paths: string[];
  /** Every verified copy of the synced sound file, absolute; empty when not synced. */
  soundPaths: string[];
  /** The sound file's channels, sample rate, start (seconds since midnight) and length, when read. */
  soundChannels: number | null;
  sampleRate: number | null;
  soundStartSec: number | null;
  soundDurationSec: number | null;
}

/** What a daily needs to know about one take's clip. */
export interface DailyPlan {
  takeId: string;
  label: string;
  scene: string;
  setup: string;
  take: string;
  clip: string;
  card: string;
  circle: boolean;
  notes: string;
  clipPaths: string[];
  meta: MediaMeta | null;
  metaError: string | null;
  sound: { key: string; paths: string[]; alignFrames: number; channels: number; accepted: boolean } | null;
  lut: { name: string; format: 'cube' | '3dl'; content: string } | null;
}

const AUDIO_FILE = /\.(wav|bwf)$/i;

/** A sync record as kept. */
export interface SyncRecord {
  card: string;
  clipKey: string;
  soundCard: string | null;
  soundKey: string | null;
  method: 'Timecode' | 'Waveform' | 'Manual' | 'None';
  alignFrames: number | null;
  baseFrames: number | null;
  fps: number | null;
  confidence: number;
  why: string;
  accepted: boolean;
  decided: 'auto' | 'dit';
  barsPicture: number[];
  barsSound: number[];
}

/** A media file of the day as sync sees it. */
export interface SyncMedia {
  card: string;
  key: string;
  meta: MediaMeta | null;
  metaError: string | null;
  mtimeMs: number;
  /** Readable copies, best first: verified destination copies, then the card. */
  paths: string[];
}

/** A VFX shot's key: the take and the clip on its card. */
const shotKey = (shot: { scene: string; setup: string; take: string; card: string | null; clip: string }) =>
  [shot.scene, shot.setup, shot.take, shot.card ?? '-', shot.clip].join('|');

/** One destination's verified copy of a clip. */
interface ClipLocation {
  legId: string;
  name: string;
  root: string;
  cardDir: string;
  files: MirrorFile[];
  checksum: ChecksumMethod;
}

/** What a log row says, as a key for the DIT's decision about it. */
const entryKey = (entry: LogEntry) =>
  [entry.scene, entry.setup, entry.take, entry.cameras.join(','), entry.clipRefs.join(','), entry.roll, entry.tcIn].join('|');

let sql: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null;
const engine = (wasm: string) =>
  (sql ??= readFile(wasm).then((binary) =>
    initSqlJs({ wasmBinary: binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer }),
  ));

const now = () => new Date().toISOString();

export const DEFAULT_PRODUCTION: Production = {
  name: 'Untitled production',
  code: 'PROD',
  frameRate: '23.976 fps',
  checksum: 'xxHash64',
  totalDays: 30,
  devices: [],
  namingTokens: DEFAULT_NAMING,
  vfxMethod: 'Hard link',
  formatRule: 'two-local',
};

const CONFLICT = 'sources:';
const pad2 = (take: string) => takeNumber(take).padStart(2, '0');
/** How one source's word on a clip is named in Match Review: "Sc 14 / B / T03". */
const claimLabel = (claim: Claim) => `Sc ${claim.scene} / ${claim.setup || '—'} / T${pad2(claim.take)}`;

/** Clips whose sources disagree (or did, until the DIT decided), as Match Review entries. */
const sourceConflicts = (assigned: Assignment[]): MatchEntry[] =>
  assigned
    .filter((item) => item.conflict || item.claims.some((claim) => claim.source === 'manual' && claim.from === 'Decided in Match Review') || (item.by === 'manual' && !item.slate && new Set(item.claims.map(claimLabel)).size > 1))
    .map((item) => {
      const said = item.claims.filter((claim) => claim.source !== 'manual');
      const labels = [...new Set(said.map(claimLabel))];
      const decided = item.claims.find((claim) => claim.source === 'manual');
      return {
        id: `${CONFLICT}${item.card}|${item.clip}`,
        kind: 'sources' as const,
        log: `${item.clip} · ${item.card}`,
        reason: `What the sources say about this clip does not agree, so it is not placed until you pick one. ${said.map((claim) => `${SOURCE_WORD[claim.source]}: ${claimLabel(claim)}`).join('. ')}.`,
        fields: said.map((claim): [string, string] => [SOURCE_WORD[claim.source], `${claimLabel(claim)}${claim.circle ? ' ◎' : ''}`]),
        candidates: labels.map((label) => {
          const from = said.filter((claim) => claimLabel(claim) === label);
          return { clip: label, tc: '', confidence: Math.round((100 * from.length) / said.length), why: from.map((claim) => claim.from).join(' · ') };
        }),
        picked: 0,
        resolution: decided ? { kind: 'matched' as const, clip: claimLabel(decided) } : item.by === 'manual' && !item.slate ? { kind: 'wild' as const } : null,
      };
    });

/**
 * The scene list with every clip the log does not already place: a take
 * the camera report, the sound slate or the DIT gave it, so the Scene
 * Organizer and the Files panel show where it went.
 */
const withAssignedTakes = (
  scenes: (SceneEntry & { setups: SetupEntry[] })[],
  assigned: Assignment[],
  records: Map<string, SyncRecord>,
): (SceneEntry & { setups: SetupEntry[] })[] => {
  const out = scenes.map((scene) => ({ ...scene, setups: scene.setups.map((setup) => ({ ...setup, takes: [...setup.takes] })) }));
  const shown = new Set(out.flatMap((scene) => scene.setups.flatMap((setup) => setup.takes.flatMap((take) => [take.clipA, take.clipB ?? '']))));
  for (const item of assigned) {
    if (!item.slate || item.by === 'log' || shown.has(item.clip)) continue;
    const { scene: sceneId, setup: setupId, take, circle } = item.slate;
    let scene = out.find((candidate) => candidate.id.toUpperCase() === sceneId.toUpperCase());
    if (!scene) {
      scene = { id: sceneId, description: '', status: 'Shot', notes: '', look: '', setups: [] };
      out.push(scene);
    }
    const setupKey = setupId || '—';
    let setup = scene.setups.find((candidate) => candidate.id === setupKey);
    if (!setup) {
      setup = { id: setupKey, lens: '', takes: [] };
      scene.setups.push(setup);
      scene.setups.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    }
    const id = `${scene.id}|${setupKey}|${takeNumber(take)}`;
    const existing = setup.takes.find((candidate) => candidate.id === id);
    if (existing) {
      if (!existing.clipB && existing.clipA !== item.clip) existing.clipB = item.clip;
      continue;
    }
    const record = records.get(item.clip);
    setup.takes.push({
      id,
      take: `T${pad2(take)}`,
      clipA: item.clip,
      clipB: null,
      sound: record?.soundKey ?? '—',
      tc: '—',
      duration: '—',
      circle,
      vfx: false,
      match: 'Matched',
      sync: record ? (record.method === 'None' ? 'none' : record.method === 'Waveform' ? 'WF' : 'TC') : 'pending',
    });
    setup.takes.sort((a, b) => a.take.localeCompare(b.take, undefined, { numeric: true }));
  }
  return out;
};

export class ProductionDb {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly db: Database,
    readonly file: string,
    private readonly saveDelayMs: number,
  ) {}

  /** Open a production file, or make a new one there. */
  static async open(file: string, options: { wasm: string; create?: Partial<Production>; saveDelayMs?: number }): Promise<ProductionDb> {
    const SQL = await engine(options.wasm);
    let bytes: Uint8Array | null = null;
    try {
      bytes = await readFile(file);
    } catch (cause) {
      if ((cause as { code?: string }).code !== 'ENOENT' || !options.create) throw cause;
    }
    let db: Database;
    try {
      db = new SQL.Database(bytes ?? undefined);
      db.exec('select count(*) from sqlite_master');
    } catch {
      throw new Error('That file is not a VC DIT production database.');
    }
    const production = new ProductionDb(db, file, options.saveDelayMs ?? 500);
    if (bytes) {
      if (!production.isProduction()) throw new Error('That file is not a VC DIT production database.');
      await copyFile(file, `${file}.bak`).catch(() => undefined);
    }
    production.migrate();
    if (!bytes) {
      production.create({ ...DEFAULT_PRODUCTION, ...options.create });
      await production.flush();
    }
    return production;
  }

  private isProduction(): boolean {
    const version = this.value<number>('pragma user_version') ?? 0;
    return version === 0
      ? this.rows('select name from sqlite_master').length === 0
      : this.rows("select 1 from sqlite_master where name = 'production'").length > 0;
  }

  private migrate() {
    const version = this.value<number>('pragma user_version') ?? 0;
    if (version > MIGRATIONS.length) throw new Error('This production was saved by a newer VC DIT. Update the app to open it.');
    for (let next = version; next < MIGRATIONS.length; next += 1) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[next]!);
        this.db.exec(`pragma user_version = ${next + 1}`);
      });
    }
  }

  private create(production: Production) {
    const at = now();
    this.transaction(() => {
      this.run(
        `insert into production (id, name, code, frame_rate, checksum, total_days, devices, naming_tokens, current_day, created_at, updated_at)
         values (1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          production.name,
          production.code,
          production.frameRate,
          production.checksum,
          production.totalDays,
          JSON.stringify(production.devices),
          JSON.stringify(production.namingTokens),
          at,
          at,
        ],
      );
      this.run('update production set vfx_method = ?, format_rule = ? where id = 1', [production.vfxMethod, production.formatRule]);
      this.run('insert into shoot_day (number, date, created_at) values (1, ?, ?)', [localDate(), at]);
    });
  }

  // ------------------------------------------------ plumbing

  private run(statement: string, params: SqlValue[] = []) {
    this.db.run(statement, params);
  }

  private rows<T = Record<string, SqlValue>>(statement: string, params: SqlValue[] = []): T[] {
    const prepared = this.db.prepare(statement);
    try {
      prepared.bind(params);
      const out: T[] = [];
      while (prepared.step()) out.push(prepared.getAsObject() as T);
      return out;
    } finally {
      prepared.free();
    }
  }

  private value<T extends SqlValue>(statement: string, params: SqlValue[] = []): T | null {
    const result = this.db.exec(statement, params);
    return (result[0]?.values[0]?.[0] as T | undefined) ?? null;
  }

  private transaction(work: () => void) {
    this.db.exec('begin');
    try {
      work();
      this.db.exec('commit');
    } catch (cause) {
      this.db.exec('rollback');
      throw cause;
    }
    this.changed();
  }

  private changed() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.saveDelayMs);
    this.timer.unref?.();
  }

  /** Write the database to its file now (and wait for any write already going). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const bytes = this.db.export();
    this.writing = this.writing.then(async () => {
      const temporary = `${this.file}.saving`;
      await writeFile(temporary, bytes);
      await rename(temporary, this.file);
    });
    return this.writing;
  }

  /** A copy of the whole production, as it is now, at another path. */
  async saveCopy(path: string): Promise<void> {
    await writeFile(path, this.db.export());
  }

  async close(): Promise<void> {
    await this.flush();
    this.db.close();
  }

  // ------------------------------------------------ production

  production(): Production {
    const row = this.rows<Record<string, string | number>>('select * from production where id = 1')[0]!;
    return {
      name: String(row['name']),
      code: String(row['code']),
      frameRate: String(row['frame_rate']),
      checksum: row['checksum'] as ChecksumMethod,
      totalDays: Number(row['total_days']),
      devices: JSON.parse(String(row['devices'])) as Production['devices'],
      namingTokens: JSON.parse(String(row['naming_tokens'])) as string[],
      vfxMethod: MIRROR_METHODS.includes(row['vfx_method'] as MirrorMethod) ? (row['vfx_method'] as MirrorMethod) : 'Hard link',
      formatRule: FORMAT_RULES.includes(row['format_rule'] as FormatRule) ? (row['format_rule'] as FormatRule) : 'two-local',
      renameClips: Number(row['rename_clips'] ?? 0) === 1,
    };
  }

  updateProduction(patch: Partial<Production>) {
    const next = { ...this.production(), ...patch };
    this.transaction(() =>
      this.run(
        'update production set name = ?, code = ?, frame_rate = ?, checksum = ?, total_days = ?, devices = ?, naming_tokens = ?, vfx_method = ?, format_rule = ?, rename_clips = ?, updated_at = ? where id = 1',
        [
          next.name,
          next.code,
          next.frameRate,
          next.checksum,
          next.totalDays,
          JSON.stringify(next.devices),
          JSON.stringify(next.namingTokens),
          next.vfxMethod,
          next.formatRule,
          next.renameClips ? 1 : 0,
          now(),
        ],
      ),
    );
  }

  // ------------------------------------------------ shoot days

  private static day(row: Record<string, SqlValue>): ShootDay {
    return {
      number: Number(row['number']),
      date: String(row['date']),
      locations: String(row['locations']),
      operator: { name: String(row['operator_name']), initials: String(row['operator_initials']) },
    };
  }

  days(): ShootDay[] {
    return this.rows('select * from shoot_day order by number').map(ProductionDb.day);
  }

  currentDay(): ShootDay {
    const number = this.value<number>('select current_day from production where id = 1') ?? 1;
    const row = this.rows('select * from shoot_day where number = ?', [number])[0] ?? this.rows('select * from shoot_day order by number limit 1')[0]!;
    return ProductionDb.day(row);
  }

  /** The next day: numbered after the last one, dated today (or the day after the last, if that is later), and opened. */
  addDay(): ShootDay {
    const last = this.days().at(-1);
    const number = (last?.number ?? 0) + 1;
    let date = localDate();
    if (last && last.date >= date) {
      const following = new Date(`${last.date}T12:00:00`);
      following.setDate(following.getDate() + 1);
      date = localDate(following);
    }
    this.transaction(() => {
      this.run('insert into shoot_day (number, date, locations, operator_name, operator_initials, created_at) values (?, ?, ?, ?, ?, ?)', [
        number,
        date,
        '',
        last?.operator.name ?? '',
        last?.operator.initials ?? '',
        now(),
      ]);
      this.run('update production set current_day = ? where id = 1', [number]);
    });
    return this.currentDay();
  }

  openDay(number: number) {
    if (!this.days().some((day) => day.number === number)) throw new Error('No such shoot day.');
    this.transaction(() => this.run('update production set current_day = ? where id = 1', [number]));
  }

  updateDay(number: number, patch: Partial<Omit<ShootDay, 'number'>>) {
    const day = this.days().find((candidate) => candidate.number === number);
    if (!day) throw new Error('No such shoot day.');
    const next = { ...day, ...patch, operator: { ...day.operator, ...patch.operator } };
    this.transaction(() =>
      this.run('update shoot_day set date = ?, locations = ?, operator_name = ?, operator_initials = ? where number = ?', [
        next.date,
        next.locations,
        next.operator.name,
        next.operator.initials,
        number,
      ]),
    );
  }

  // ------------------------------------------------ scenes

  scenes(day: number): SceneEntry[] {
    return this.rows<Record<string, string>>('select * from scene where day = ? order by position', [day]).map((row) => ({
      id: row['id']!,
      description: row['description']!,
      status: row['status'] as SceneStatus,
      notes: row['notes']!,
      look: row['look']!,
    }));
  }

  addScene(day: number, scene: Pick<SceneEntry, 'id'> & Partial<SceneEntry>): boolean {
    const id = scene.id.trim().toUpperCase();
    if (!id || this.scenes(day).some((existing) => existing.id === id)) return false;
    const position = (this.value<number>('select max(position) from scene where day = ?', [day]) ?? 0) + 1;
    this.transaction(() =>
      this.run('insert into scene (day, id, description, status, notes, look, position) values (?, ?, ?, ?, ?, ?, ?)', [
        day,
        id,
        scene.description?.trim() ?? '',
        scene.status ?? 'Scheduled',
        scene.notes ?? '',
        scene.look ?? '',
        position,
      ]),
    );
    return true;
  }

  updateScene(day: number, id: string, patch: Partial<Omit<SceneEntry, 'id'>>) {
    const scene = this.scenes(day).find((candidate) => candidate.id === id);
    if (!scene) throw new Error('No such scene.');
    const next = { ...scene, ...patch };
    this.transaction(() =>
      this.run('update scene set description = ?, status = ?, notes = ?, look = ? where day = ? and id = ?', [
        next.description,
        next.status,
        next.notes,
        next.look,
        day,
        id,
      ]),
    );
  }

  removeScene(day: number, id: string) {
    this.transaction(() => this.run('delete from scene where day = ? and id = ?', [day, id]));
  }

  // ------------------------------------------------ transfers and clips

  /** Keep a transfer as it stands now; called again as it progresses, it replaces what was kept. */
  saveTransfer(record: TransferRecord) {
    this.transaction(() => {
      const key = [record.day, record.id];
      this.run('delete from clip_copy where clip_id in (select id from clip where day = ? and transfer_id = ?)', key);
      this.run('delete from clip where day = ? and transfer_id = ?', key);
      this.run('delete from transfer_destination where day = ? and transfer_id = ?', key);
      this.run('delete from transfer where day = ? and id = ?', key);
      this.run('insert into transfer (id, day, card, label, source_root, sound, checksum, started_at, finished_at, cleared_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        record.id,
        record.day,
        record.card,
        record.label,
        record.sourceRoot,
        record.sound ? 1 : 0,
        record.checksum,
        record.startedAt,
        record.finishedAt,
        record.clearedAt ?? null,
      ]);
      for (const [position, destination] of record.destinations.entries()) {
        this.run(
          'insert into transfer_destination (day, transfer_id, leg_id, position, name, root, target_dir, reports_dir, error, relay, relay_from, local, tape) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            record.day,
            record.id,
            destination.id,
            position,
            destination.name,
            destination.root,
            destination.targetDir,
            destination.reportsDir,
            destination.error,
            destination.relay ? 1 : 0,
            destination.relayFrom ?? null,
            destination.local === undefined ? null : destination.local ? 1 : 0,
            destination.tape ? 1 : 0,
          ],
        );
      }
      const insertClip = this.db.prepare(
        `insert into clip (day, transfer_id, card, path, file_name, kind, size, mtime_ms, checksum_method, checksum, hashed_at, source_path)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      );
      const insertCopy = this.db.prepare('insert into clip_copy (clip_id, leg_id, state, error) values (?, ?, ?, ?)');
      try {
        for (const file of record.files) {
          insertClip.bind([
            record.day,
            record.id,
            record.card,
            file.path,
            file.path.split('/').pop()!,
            record.sound ? 'sound' : 'camera',
            file.size,
            file.mtimeMs,
            record.checksum,
            file.hash,
            file.hashedAt,
            file.source ?? null,
          ]);
          insertClip.step();
          const clipId = insertClip.get()[0] as number;
          insertClip.reset();
          for (const destination of record.destinations) {
            const outcome = destination.outcomes[file.path];
            if (!outcome) continue;
            insertCopy.run([clipId, destination.id, outcome.state, outcome.error ?? null]);
          }
        }
      } finally {
        insertClip.free();
        insertCopy.free();
      }
    });
  }

  transfers(day: number): TransferRecord[] {
    const transfers = this.rows<Record<string, SqlValue>>('select * from transfer where day = ? order by started_at, id', [day]);
    return transfers.map((row) => {
      const id = String(row['id']);
      const destinations = this.rows<Record<string, SqlValue>>('select * from transfer_destination where day = ? and transfer_id = ? order by position', [
        day,
        id,
      ]).map((leg) => ({
        id: String(leg['leg_id']),
        name: String(leg['name']),
        root: String(leg['root']),
        targetDir: String(leg['target_dir']),
        reportsDir: String(leg['reports_dir']),
        error: (leg['error'] as string | null) ?? null,
        outcomes: {} as Record<string, FileOutcome>,
        relay: Number(leg['relay']) === 1,
        relayFrom: (leg['relay_from'] as string | null) ?? null,
        ...(leg['local'] === null || leg['local'] === undefined ? {} : { local: Number(leg['local']) === 1 }),
        ...(Number(leg['tape'] ?? 0) === 1 ? { tape: true } : {}),
      }));
      const clips = this.rows<Record<string, SqlValue>>('select * from clip where day = ? and transfer_id = ? order by id', [day, id]);
      const byLeg = new Map(destinations.map((destination) => [destination.id, destination]));
      for (const copy of this.rows<Record<string, SqlValue>>(
        'select c.path, cc.leg_id, cc.state, cc.error from clip_copy cc join clip c on c.id = cc.clip_id where c.day = ? and c.transfer_id = ?',
        [day, id],
      )) {
        const outcome: FileOutcome = { state: copy['state'] as FileOutcome['state'] };
        if (copy['error']) outcome.error = String(copy['error']);
        const destination = byLeg.get(String(copy['leg_id']));
        if (destination) destination.outcomes[String(copy['path'])] = outcome;
      }
      return {
        id,
        day,
        card: String(row['card']),
        label: String(row['label']),
        sourceRoot: String(row['source_root']),
        sound: Number(row['sound']) === 1,
        checksum: row['checksum'] as ChecksumMethod,
        startedAt: (row['started_at'] as string | null) ?? null,
        finishedAt: (row['finished_at'] as string | null) ?? null,
        clearedAt: (row['cleared_at'] as string | null) ?? null,
        files: clips.map((clip) => ({
          path: String(clip['path']),
          ...(clip['source_path'] ? { source: String(clip['source_path']) } : {}),
          size: Number(clip['size']),
          mtimeMs: Number(clip['mtime_ms']),
          hash: (clip['checksum'] as string | null) ?? null,
          hashedAt: (clip['hashed_at'] as string | null) ?? null,
        })),
        destinations,
      };
    });
  }

  // ------------------------------------------------ the script supervisor's log

  /**
   * Replace the day's log with a newly imported one. Scenes it names that are
   * not on the day's list are added (as shot); then every row is matched.
   */
  importLog(day: number, fileName: string, parsed: ParsedLog): void {
    const listed = this.scenes(day);
    const ids = new Set(listed.map((scene) => scene.id));
    // "12A" is scene 12A when the list has it (and no scene 12), else scene 12, setup A.
    const entries = parsed.entries.map((entry) =>
      entry.setup && ids.has(entry.slate) && !ids.has(entry.scene) ? { ...entry, scene: entry.slate, setup: '' } : entry,
    );
    this.transaction(() => {
      this.clearLogRows(day);
      for (const [position, entry] of entries.entries()) {
        this.run(
          `insert into script_entry (day, position, scene, setup, take, slate, cameras, clip_refs, roll, sound_roll, sound_ref, tc_in, tc_out,
             circle, print, vfx, vfx_note, notes, lens, description)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            day,
            position,
            entry.scene,
            entry.setup,
            entry.take,
            entry.slate,
            JSON.stringify(entry.cameras),
            JSON.stringify(entry.clipRefs),
            entry.roll,
            entry.soundRoll,
            entry.soundRef,
            entry.tcIn,
            entry.tcOut,
            entry.circle ? 1 : 0,
            entry.print ? 1 : 0,
            entry.vfx ? 1 : 0,
            entry.vfxNote,
            entry.notes,
            entry.lens,
            entry.description,
          ],
        );
      }
      this.run('insert or replace into script_import (day, file_name, format, imported_at, warnings) values (?, ?, ?, ?, ?)', [
        day,
        fileName,
        parsed.format,
        now(),
        JSON.stringify(parsed.warnings.slice(0, 200)),
      ]);
      // Scenes the log names that the day's list does not have yet.
      let position = this.value<number>('select max(position) from scene where day = ?', [day]) ?? 0;
      for (const entry of entries) {
        if (ids.has(entry.scene)) continue;
        ids.add(entry.scene);
        position += 1;
        this.run("insert into scene (day, id, description, status, notes, look, position) values (?, ?, ?, 'Shot', '', '', ?)", [
          day,
          entry.scene,
          entry.description,
          position,
        ]);
      }
    });
    this.rematch(day);
  }

  private clearLogRows(day: number) {
    this.run('delete from script_match where entry_id in (select id from script_entry where day = ?)', [day]);
    this.run('delete from script_sound where entry_id in (select id from script_entry where day = ?)', [day]);
    this.run('delete from script_entry where day = ?', [day]);
  }

  private logEntries(day: number): StoredEntry[] {
    return this.rows<Record<string, SqlValue>>('select * from script_entry where day = ? order by position', [day]).map((row) => ({
      id: Number(row['id']),
      line: Number(row['position']) + 1,
      scene: String(row['scene']),
      setup: String(row['setup']),
      take: String(row['take']),
      slate: String(row['slate']),
      cameras: JSON.parse(String(row['cameras'])) as string[],
      clipRefs: JSON.parse(String(row['clip_refs'])) as string[],
      roll: String(row['roll']),
      soundRoll: String(row['sound_roll']),
      soundRef: String(row['sound_ref']),
      tcIn: String(row['tc_in']),
      tcOut: String(row['tc_out']),
      circle: Number(row['circle']) === 1,
      print: Number(row['print']) === 1,
      vfx: Number(row['vfx']) === 1,
      vfxNote: String(row['vfx_note']),
      notes: String(row['notes']),
      lens: String(row['lens']),
      description: String(row['description']),
    }));
  }

  /** Match the day's log against the day's clips again: after an import, and whenever another card comes in. */
  rematch(day: number): void {
    const entries = this.logEntries(day);
    if (entries.length === 0) return;
    const clips = this.rows<Record<string, SqlValue>>('select card, path, file_name, kind, size, mtime_ms, meta from clip where day = ?', [day]).map<DayClip>(
      (row) => {
        // Once its header is read, a clip's own timecode span (in timecode seconds) helps place logged takes.
        const parsed = row['meta'] ? (JSON.parse(String(row['meta'])) as MetaResult) : null;
        const meta = parsed?.ok ? parsed.meta : null;
        const rate = meta?.rate && meta.rate.den ? meta.rate.num / meta.rate.den : null;
        const tc = meta?.tc && rate ? { start: meta.tc.frames / meta.tc.base, end: (meta.tc.frames + meta.durationSec * rate) / meta.tc.base } : null;
        return {
          card: String(row['card']),
          path: String(row['path']),
          fileName: String(row['file_name']),
          kind: row['kind'] as DayClip['kind'],
          size: Number(row['size']),
          mtimeMs: Number(row['mtime_ms']),
          tc,
        };
      },
    );
    const results = matchDay(entries, clips);
    const decisions = new Map(
      this.rows<Record<string, SqlValue>>('select * from script_decision where day = ?', [day]).map((row) => [
        `${String(row['entry_key'])}#${Number(row['ref_index'])}`,
        { key: (row['clip_key'] as string | null) ?? null, card: (row['clip_card'] as string | null) ?? null },
      ]),
    );
    this.transaction(() => {
      this.run('delete from script_match where entry_id in (select id from script_entry where day = ?)', [day]);
      this.run('delete from script_sound where entry_id in (select id from script_entry where day = ?)', [day]);
      for (const entry of entries) {
        const result = results.get(entry)!;
        for (const [index, ref] of result.camera.entries()) {
          const decision = decisions.get(`${entryKey(entry)}#${index}`);
          const decided = decision ? (decision.key ? 'dit' : 'wild') : 'auto';
          this.run(
            `insert into script_match (entry_id, ref_index, ref, camera, state, clip_key, clip_card, candidates, reason, decided)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              entry.id,
              index,
              ref.ref,
              ref.camera,
              decision ? 'matched' : ref.state,
              decision ? decision.key : (ref.clip?.key ?? null),
              decision ? decision.card : (ref.clip?.card ?? null),
              // A decided clip stays among the candidates, so the screen can show what was picked.
              JSON.stringify(
                decision?.key && !ref.candidates.some((candidate) => candidate.key === decision.key && candidate.card === decision.card)
                  ? [...ref.candidates, { key: decision.key, card: decision.card ?? '', tc: '—', confidence: 0, why: 'Picked by the DIT' }]
                  : ref.candidates,
              ),
              ref.reason,
              decided,
            ],
          );
        }
        if (result.sound)
          this.run('insert into script_sound (entry_id, clip_key, clip_card) values (?, ?, ?)', [entry.id, result.sound.key, result.sound.card]);
      }
    });
  }

  /** The DIT's decision on one row's clip: a candidate (by the label the screen showed), or none at all (wild, MOS, no camera). */
  resolveMatch(day: number, id: string, label: string | null): void {
    // Sources that disagreed about a clip: the DIT picks what one of them said, or that it goes nowhere.
    if (id.startsWith(CONFLICT)) {
      const [card, clip] = id.slice(CONFLICT.length).split('|') as [string, string];
      const assignment = this.assignments(day).find((item) => item.card === card && item.clip === clip);
      if (!assignment) throw new Error('That clip is no longer in the day.');
      if (label === null) {
        this.assignClips(day, [{ card, clip }], null, 'none');
        return;
      }
      const claim = assignment.claims.find((candidate) => candidate.source !== 'manual' && claimLabel(candidate) === label);
      if (!claim) throw new Error('That is not one of the choices.');
      this.assignClips(day, [{ card, clip }], { scene: claim.scene, setup: claim.setup, take: claim.take, circle: claim.circle }, 'decided');
      return;
    }
    const [entryId, refIndex] = id.split(':').map(Number) as [number, number];
    const entry = this.logEntries(day).find((candidate) => candidate.id === entryId);
    const row = this.rows<Record<string, SqlValue>>('select candidates from script_match where entry_id = ? and ref_index = ?', [entryId, refIndex])[0];
    if (!entry || !row) throw new Error('That log entry is no longer in the log.');
    let clip: Candidate | null = null;
    if (label !== null) {
      const candidates = JSON.parse(String(row['candidates'])) as Candidate[];
      clip = candidates.find((candidate) => candidateLabel(candidate, candidates) === label) ?? null;
      if (!clip) throw new Error('That clip is not one of the candidates.');
    }
    this.transaction(() => {
      this.run('insert or replace into script_decision (day, entry_key, ref_index, clip_key, clip_card) values (?, ?, ?, ?, ?)', [
        day,
        entryKey(entry),
        refIndex,
        clip?.key ?? null,
        clip?.card ?? null,
      ]);
      this.run("update script_match set state = 'matched', clip_key = ?, clip_card = ?, decided = ? where entry_id = ? and ref_index = ?", [
        clip?.key ?? null,
        clip?.card ?? null,
        clip ? 'dit' : 'wild',
        entryId,
        refIndex,
      ]);
    });
  }

  /** The day's scenes with their setups and takes, the entries to review, the VFX flags and the import's numbers. */
  logView(day: number): Pick<ProjectState, 'scenes' | 'log' | 'matches' | 'vfx'> {
    const entries = this.logEntries(day);
    const ids = new Set(entries.map((entry) => entry.id));
    const matches = this.rows<Record<string, SqlValue>>(
      'select m.* from script_match m join script_entry e on e.id = m.entry_id where e.day = ? order by e.position, m.ref_index',
      [day],
    ).map<StoredMatch>((row) => ({
      entryId: Number(row['entry_id']),
      refIndex: Number(row['ref_index']),
      ref: String(row['ref']),
      camera: String(row['camera']),
      state: row['state'] as StoredMatch['state'],
      clipKey: (row['clip_key'] as string | null) ?? null,
      clipCard: (row['clip_card'] as string | null) ?? null,
      candidates: JSON.parse(String(row['candidates'])) as Candidate[],
      reason: String(row['reason']),
      decided: row['decided'] as StoredMatch['decided'],
    }));
    const sounds = new Map(
      this.rows<Record<string, SqlValue>>('select entry_id, clip_key from script_sound')
        .filter((row) => ids.has(Number(row['entry_id'])))
        .map((row) => [Number(row['entry_id']), String(row['clip_key'])]),
    );
    const imported = this.rows<Record<string, SqlValue>>('select * from script_import where day = ?', [day])[0];
    const log: StoredImport | null = imported
      ? {
          fileName: String(imported['file_name']),
          format: String(imported['format']),
          importedAt: String(imported['imported_at']),
          warnings: JSON.parse(String(imported['warnings'])) as string[],
        }
      : null;
    const view = buildLogView({ scenes: this.scenes(day), entries, matches, sounds, log, frameRate: this.production().frameRate });
    // A take's sync and sound come from its A camera clip's sync record.
    const records = new Map(this.syncRecords(day).map((record) => [record.clipKey, record]));
    const scenes = view.scenes.map((scene) => ({
      ...scene,
      setups: scene.setups.map((setup) => ({
        ...setup,
        takes: setup.takes.map((take) => {
          const record = records.get(take.clipA);
          if (!record) return take;
          const sync: typeof take.sync = record.method === 'None' ? 'none' : record.method === 'Waveform' ? 'WF' : 'TC';
          return { ...take, sync, sound: record.soundKey ?? take.sound };
        }),
      })),
    }));
    const assigned = this.assignments(day);
    return {
      ...view,
      scenes: withAssignedTakes(scenes, assigned, records),
      matches: [...view.matches, ...sourceConflicts(assigned)],
      vfx: this.vfxShots(day, view.vfx).map(({ entry }) => entry),
    };
  }

  // ------------------------------------------------ sync

  /** Every readable copy of a file of the day: verified destination copies first, then where it came from. */
  private copiesOf(day: number, card: string, path: string): string[] {
    const rows = this.rows<Record<string, SqlValue>>(
      `select td.target_dir, t.source_root, cc.state, c.source_path
       from clip c
       join transfer t on t.day = c.day and t.id = c.transfer_id
       left join clip_copy cc on cc.clip_id = c.id
       left join transfer_destination td on td.day = c.day and td.transfer_id = c.transfer_id and td.leg_id = cc.leg_id
       where c.day = ? and c.card = ? and c.path = ?`,
      [day, card, path],
    );
    const parts = path.split('/');
    const verified = rows.filter((row) => row['state'] && row['state'] !== 'failed' && row['target_dir']).map((row) => join(String(row['target_dir']), ...parts));
    // On the card itself, by its own name (its copies may be named after the card).
    const sources = rows.map((row) => join(String(row['source_root']), ...(row['source_path'] ? String(row['source_path']).split('/') : parts)));
    return [...new Set([...verified, ...sources])];
  }

  /** Media files whose header has not been read yet. */
  pendingMeta(day: number): { card: string; path: string; paths: string[] }[] {
    const rows = this.rows<Record<string, SqlValue>>('select distinct card, path, file_name, meta is null as pending from clip where day = ? order by path', [day]);
    // An image sequence is read once, from its first frame: its thousands of frames are one clip.
    const sequences = new Map<string, { first: Record<string, SqlValue>; frame: number; read: boolean }>();
    const singles: Record<string, SqlValue>[] = [];
    for (const row of rows) {
      const name = String(row['file_name']);
      const sequence = sequenceOf(name);
      if (!sequence) {
        if (Number(row['pending']) === 1 && (isPictureFile(name) || AUDIO_FILE.test(name))) singles.push(row);
        continue;
      }
      const path = String(row['path']);
      const key = `${String(row['card'])}|${path.slice(0, path.length - name.length)}${sequence.stem.toUpperCase()}`;
      const group = sequences.get(key);
      const read = Number(row['pending']) !== 1;
      if (!group) sequences.set(key, { first: row, frame: sequence.frame, read });
      else {
        group.read ||= read;
        if (sequence.frame < group.frame) Object.assign(group, { first: row, frame: sequence.frame });
      }
    }
    const firsts = [...sequences.values()].filter((group) => !group.read).map((group) => group.first);
    return [...singles, ...firsts].map((row) => ({ card: String(row['card']), path: String(row['path']), paths: this.copiesOf(day, String(row['card']), String(row['path'])) }));
  }

  saveMeta(day: number, card: string, path: string, result: MetaResult) {
    this.transaction(() => this.run('update clip set meta = ? where day = ? and card = ? and path = ?', [JSON.stringify(result), day, card, path]));
  }

  /** The day's camera clips (one media file each) and sound files, with what their headers said. */
  syncMedia(day: number): { pictures: (SyncMedia & { hint: { card: string; key: string } | null })[]; sounds: SyncMedia[] } {
    const rows = this.rows<Record<string, SqlValue>>('select card, path, file_name, kind, mtime_ms, meta from clip where day = ? order by path', [day]);
    const hints = new Map(
      this.rows<Record<string, SqlValue>>(
        `select m.clip_card, m.clip_key, s.clip_card as sound_card, s.clip_key as sound_key
         from script_match m join script_entry e on e.id = m.entry_id join script_sound s on s.entry_id = e.id
         where e.day = ? and m.state = 'matched' and m.clip_key is not null`,
        [day],
      ).map((row) => [`${String(row['clip_card'])}|${String(row['clip_key'])}`, { card: String(row['sound_card']), key: String(row['sound_key']) }]),
    );
    const pictures = new Map<string, SyncMedia & { hint: { card: string; key: string } | null }>();
    const sounds = new Map<string, SyncMedia>();
    /** Frames of each image sequence clip. */
    const frames = new Map<string, number>();
    for (const row of rows) {
      const name = String(row['file_name']);
      const card = String(row['card']);
      const path = String(row['path']);
      const parsed = row['meta'] ? (JSON.parse(String(row['meta'])) as MetaResult) : null;
      const media = {
        card,
        meta: parsed?.ok ? parsed.meta : null,
        metaError: parsed && !parsed.ok ? parsed.error : null,
        mtimeMs: Number(row['mtime_ms']),
      };
      if (row['kind'] === 'camera' && isPictureFile(name)) {
        const key = pictureKey(name);
        const id = `${card}|${key}`;
        if (sequenceOf(name)) frames.set(id, (frames.get(id) ?? 0) + 1);
        // A clip in several files (RED spans, every frame of a sequence): its first file speaks for it.
        if (!pictures.has(id)) pictures.set(id, { ...media, key, paths: this.copiesOf(day, card, path), hint: hints.get(id) ?? null });
      } else if (row['kind'] === 'sound' && AUDIO_FILE.test(name)) {
        const key = name.replace(/\.[^.]+$/, '');
        const id = `${card}|${key}`;
        if (!sounds.has(id)) sounds.set(id, { ...media, key, paths: this.copiesOf(day, card, path) });
      }
    }
    // An image sequence runs as long as its frames do, at the rate its first frame gives.
    for (const [id, count] of frames) {
      const picture = pictures.get(id)!;
      if (picture.meta?.sequence && picture.meta.rate) picture.meta = { ...picture.meta, durationSec: (count * picture.meta.rate.den) / picture.meta.rate.num };
    }
    return { pictures: [...pictures.values()], sounds: [...sounds.values()] };
  }

  syncRecords(day: number): SyncRecord[] {
    return this.rows<Record<string, SqlValue>>('select * from sync_record where day = ?', [day]).map((row) => ({
      card: String(row['card']),
      clipKey: String(row['clip_key']),
      soundCard: (row['sound_card'] as string | null) ?? null,
      soundKey: (row['sound_key'] as string | null) ?? null,
      method: row['method'] as SyncRecord['method'],
      alignFrames: (row['align_frames'] as number | null) ?? null,
      baseFrames: (row['base_frames'] as number | null) ?? null,
      fps: (row['fps'] as number | null) ?? null,
      confidence: Number(row['confidence']),
      why: String(row['why']),
      accepted: Number(row['accepted']) === 1,
      decided: row['decided'] as SyncRecord['decided'],
      barsPicture: JSON.parse(String(row['bars_picture'])) as number[],
      barsSound: JSON.parse(String(row['bars_sound'])) as number[],
    }));
  }

  saveSync(day: number, record: SyncRecord) {
    this.transaction(() =>
      this.run(
        `insert or replace into sync_record (day, card, clip_key, sound_card, sound_key, method, align_frames, base_frames, fps, confidence, why,
           accepted, decided, bars_picture, bars_sound, made_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          day,
          record.card,
          record.clipKey,
          record.soundCard,
          record.soundKey,
          record.method,
          record.alignFrames,
          record.baseFrames,
          record.fps,
          record.confidence,
          record.why,
          record.accepted ? 1 : 0,
          record.decided,
          JSON.stringify(record.barsPicture),
          JSON.stringify(record.barsSound),
          now(),
        ],
      ),
    );
  }

  private syncRecord(day: number, id: string): SyncRecord {
    const record = this.syncRecords(day).find((candidate) => `${candidate.card}|${candidate.clipKey}` === id);
    if (!record) throw new Error('That clip has no sync yet.');
    return record;
  }

  /** The DIT moves the sound by whole frames: the sync becomes manual, and waits to be accepted. */
  nudgeSync(day: number, id: string, frames: number) {
    const record = this.syncRecord(day, id);
    if (record.alignFrames === null) throw new Error('There is no sound to move for this clip.');
    this.saveSync(day, { ...record, method: 'Manual', alignFrames: record.alignFrames + frames, accepted: false, decided: 'dit' });
  }

  acceptSync(day: number, ids: string[]) {
    for (const id of ids) {
      const record = this.syncRecord(day, id);
      if (record.method === 'None') continue;
      this.saveSync(day, { ...record, accepted: true, decided: 'dit' });
    }
  }

  /** The day's sync as the Sync screen shows it, in take order. */
  syncView(day: number): SyncEntry[] {
    const takes = new Map(
      this.rows<Record<string, SqlValue>>(
        `select m.clip_card, m.clip_key, e.scene, e.setup, e.take from script_match m join script_entry e on e.id = m.entry_id
         where e.day = ? and m.state = 'matched' and m.clip_key is not null`,
        [day],
      ).map((row) => [
        `${String(row['clip_card'])}|${String(row['clip_key'])}`,
        `${String(row['scene'])}${String(row['setup'])}-${String(row['take']).padStart(2, '0')}`,
      ]),
    );
    return this.syncRecords(day)
      .map((record) => {
        const id = `${record.card}|${record.clipKey}`;
        return {
          id,
          take: takes.get(id) ?? record.clipKey,
          clip: record.clipKey,
          sound: record.soundKey ?? '—',
          method: record.method,
          offsetFrames: record.alignFrames !== null && record.baseFrames !== null ? Math.round(record.alignFrames - record.baseFrames) : 0,
          confidence: record.confidence,
          accepted: record.accepted,
          fps: record.fps,
          why: record.why,
          barsPicture: record.barsPicture,
          barsSound: record.barsSound,
        };
      })
      .sort((a, b) => a.take.localeCompare(b.take, undefined, { numeric: true }));
  }

  // ------------------------------------------------ VFX

  /** Where a clip's verified copies are: each destination that has every one of its files verified. */
  private clipLocations(day: number, card: string, clip: string): ClipLocation[] {
    const rows = this.rows<Record<string, SqlValue>>(
      'select id, path, file_name, size, mtime_ms, checksum, checksum_method from clip where day = ? and card = ? order by id',
      [day, card],
    ).filter((row) => {
      const name = String(row['file_name']);
      return (pictureKey(name)) === clip;
    });
    if (rows.length === 0) return [];
    const files = new Map<string, MirrorFile>();
    for (const row of rows) {
      const path = String(row['path']);
      if (!files.has(path)) {
        files.set(path, { path, size: Number(row['size']), mtimeMs: Number(row['mtime_ms']), hash: (row['checksum'] as string | null) ?? null });
      }
    }
    const ids = rows.map((row) => Number(row['id']));
    const copies = this.rows<Record<string, SqlValue>>(
      `select c.path, cc.leg_id, td.name, td.root, td.target_dir
       from clip_copy cc
       join clip c on c.id = cc.clip_id
       join transfer_destination td on td.day = c.day and td.transfer_id = c.transfer_id and td.leg_id = cc.leg_id
       where cc.state != 'failed' and c.id in (${ids.map(() => '?').join(', ')})`,
      ids,
    );
    const legs = new Map<string, { name: string; root: string; cardDir: string; verified: Set<string> }>();
    for (const copy of copies) {
      const id = String(copy['leg_id']);
      const leg = legs.get(id) ?? { name: String(copy['name']), root: String(copy['root']), cardDir: String(copy['target_dir']), verified: new Set<string>() };
      leg.verified.add(String(copy['path']));
      legs.set(id, leg);
    }
    const checksum = rows[0]!['checksum_method'] as ChecksumMethod;
    return [...legs]
      .filter(([, leg]) => [...files.keys()].every((path) => leg.verified.has(path)))
      .map(([legId, leg]) => ({ legId, name: leg.name, root: leg.root, cardDir: leg.cardDir, files: [...files.values()], checksum }));
  }

  /** The day's VFX shots: the log's flags and the DIT's tags, each with where it is and how it is mirrored. */
  private vfxShots(day: number, flags: VfxFlag[]): { entry: VfxEntry; flag: VfxFlag; locations: ClipLocation[] }[] {
    const tags = this.rows<Record<string, SqlValue>>('select * from vfx_tag where day = ? order by created_at', [day]).map<VfxFlag & { tagged: true }>((row) => ({
      scene: String(row['scene']),
      setup: String(row['setup']),
      take: String(row['take']),
      clip: String(row['clip_key']),
      card: String(row['card']),
      note: String(row['note']),
      matched: true,
      tagged: true,
    }));
    const mirrors = new Map(
      this.rows<Record<string, SqlValue>>('select * from vfx_mirror where day = ?', [day]).map((row) => [`${String(row['shot_key'])}#${String(row['leg_id'])}`, row]),
    );
    const sent = new Map(this.rows<Record<string, SqlValue>>('select shot_key, sent_at from vfx_handoff where day = ?', [day]).map((row) => [String(row['shot_key']), String(row['sent_at'])]));
    const all: (VfxFlag & { tagged?: true })[] = [...flags, ...tags.filter((tag) => !flags.some((flag) => flag.card === tag.card && flag.clip === tag.clip))];
    return all.map((flag) => {
      const key = shotKey(flag);
      const locations = flag.card ? this.clipLocations(day, flag.card, flag.clip) : [];
      const media = (location: ClipLocation) => location.files.find((file) => !/\.(xml|txt|ale|csv|json)$/i.test(file.path)) ?? location.files[0]!;
      const placed: VfxLocation[] = locations.map((location) => {
        const mirror = mirrors.get(`${key}#${location.legId}`);
        return {
          destination: location.name,
          editorial: join(location.cardDir, ...media(location).path.split('/').slice(0, -1)),
          mirror: mirror ? String(mirror['target_dir']) : null,
          method: mirror ? (String(mirror['method']) as MirrorMethod) : null,
          state: mirror ? (String(mirror['state']) as 'mirrored' | 'failed') : 'pending',
          error: mirror ? ((mirror['error'] as string | null) ?? null) : null,
        };
      });
      return {
        flag,
        locations,
        entry: {
          key,
          scene: flag.scene,
          setup: flag.setup,
          take: flag.take,
          clip: flag.clip,
          note: flag.note,
          flaggedBy: flag.tagged ? 'DIT tag' : 'Script sup.',
          matched: flag.matched,
          locations: placed,
          sentAt: sent.get(key) ?? null,
        },
      };
    });
  }

  /** Mirrors still to make on the day, by the production's method: those never made, and (when asked) those that failed. */
  mirrorPlans(day: number, retryFailed: boolean): MirrorPlan[] {
    const production = this.production();
    const date = this.days().find((candidate) => candidate.number === day)?.date ?? localDate();
    return this.vfxShots(day, this.vfxFlags(day)).flatMap(({ entry, locations }) =>
      locations
        .filter((location, index) => entry.locations[index]!.state === 'pending' || (retryFailed && entry.locations[index]!.state === 'failed'))
        .map((location) => ({
          key: entry.key,
          scene: entry.scene,
          setup: entry.setup,
          take: entry.take,
          clip: entry.clip,
          method: production.vfxMethod,
          checksum: location.checksum,
          production: { name: production.name, code: production.code },
          day: { number: day, date },
          location: { legId: location.legId, name: location.name, root: location.root, cardDir: location.cardDir, files: location.files },
        })),
    );
  }

  saveMirror(day: number, key: string, outcome: MirrorOutcome) {
    this.transaction(() =>
      this.run(
        `insert or replace into vfx_mirror (day, shot_key, leg_id, destination, method, target_dir, state, error, made_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [day, key, outcome.legId, outcome.destination, outcome.method, outcome.targetDir, outcome.state, outcome.error, now()],
      ),
    );
  }

  /** Tag a clip of the day as a VFX shot (spec §4.9 "tag additional candidates"). */
  tagVfx(day: number, clip: string, note: string) {
    const key = clip.trim().toUpperCase();
    const matched = this.rows<Record<string, SqlValue>>(
      `select e.scene, e.setup, e.take, m.clip_card from script_match m join script_entry e on e.id = m.entry_id
       where e.day = ? and m.clip_key = ? and m.state = 'matched' and m.decided != 'wild' limit 1`,
      [day, key],
    )[0];
    const card = matched
      ? String(matched['clip_card'])
      : this.rows<Record<string, SqlValue>>('select card, file_name from clip where day = ?', [day]).find(
          (row) => pictureKey(String(row['file_name'])) === key,
        )?.['card'];
    if (!card) throw new Error(`No clip named ${key} was ingested today.`);
    if (this.logView(day).vfx.some((shot) => shot.clip === key)) throw new Error(`${key} is already on the VFX list.`);
    this.transaction(() =>
      this.run('insert into vfx_tag (day, scene, setup, take, clip_key, card, note, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)', [
        day,
        matched ? String(matched['scene']) : '—',
        matched ? String(matched['setup']) || '—' : '—',
        matched ? String(matched['take']).padStart(2, '0') : '—',
        key,
        String(card),
        note.trim(),
        now(),
      ]),
    );
  }

  /** Shots ready for VC VFX Prep: known clip, mirrored somewhere, not sent yet. */
  handoffShots(day: number): { entry: VfxEntry; locations: ClipLocation[] }[] {
    return this.vfxShots(day, this.vfxFlags(day)).filter(
      ({ entry }) => entry.matched && !entry.sentAt && entry.locations.some((location) => location.state === 'mirrored'),
    );
  }

  markSent(day: number, keys: string[], packages: string[]) {
    const at = now();
    this.transaction(() => {
      for (const key of keys) this.run('insert or replace into vfx_handoff (day, shot_key, sent_at, package) values (?, ?, ?, ?)', [day, key, at, JSON.stringify(packages)]);
    });
  }

  /** The log's VFX flags for the day (no tags), for the VFX methods above. */
  vfxFlags(day: number): VfxFlag[] {
    const entries = this.logEntries(day);
    const matches = this.rows<Record<string, SqlValue>>(
      'select m.* from script_match m join script_entry e on e.id = m.entry_id where e.day = ? order by e.position, m.ref_index',
      [day],
    ).map<StoredMatch>((row) => ({
      entryId: Number(row['entry_id']),
      refIndex: Number(row['ref_index']),
      ref: String(row['ref']),
      camera: String(row['camera']),
      state: row['state'] as StoredMatch['state'],
      clipKey: (row['clip_key'] as string | null) ?? null,
      clipCard: (row['clip_card'] as string | null) ?? null,
      candidates: [],
      reason: '',
      decided: row['decided'] as StoredMatch['decided'],
    }));
    return buildLogView({ scenes: [], entries, matches, sounds: new Map(), log: null, frameRate: '24' }).vfx;
  }

  // ------------------------------------------------ looks

  luts(): LutEntry[] {
    const fallback = this.rows<Record<string, SqlValue>>("select lut_id from lut_rule where scope = 'Project'")[0]?.['lut_id'];
    const ids = new Set(this.rows<Record<string, SqlValue>>('select id from lut').map((row) => Number(row['id'])));
    return this.rows<Record<string, SqlValue>>('select id, name, format, kind, size, title, imported_at, cdl, grade, grade_base from lut order by name').map((row) => ({
      id: Number(row['id']),
      name: String(row['name']),
      title: String(row['title']),
      kind: row['kind'] as LutEntry['kind'],
      size: Number(row['size']),
      format: row['format'] as LutEntry['format'],
      importedAt: String(row['imported_at']),
      isDefault: Number(row['id']) === Number(fallback),
      cdl: row['cdl'] !== null,
      ...(row['cdl'] !== null ? { sop: JSON.parse(String(row['cdl'])) as Cdl } : {}),
      ...(Number(row['grade']) === 1 ? { grade: { baseLutId: row['grade_base'] !== null && ids.has(Number(row['grade_base'])) ? Number(row['grade_base']) : null } } : {}),
    }));
  }

  /**
   * Keep a grade from the Grade screen: its CDL, and the .cube baked from it
   * over its show LUT. Saved again under the same name, it replaces that
   * grade (its rules keep pointing at it); a LUT that was imported under the
   * name is never overwritten.
   */
  saveGrade(name: string, cdl: Cdl, baseLutId: number | null, cube: string, title: string): number {
    const clean = name.trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
    if (!clean) throw new Error('Name the grade.');
    const fileName = /\.cube$/i.test(clean) ? clean : `${clean}.cube`;
    const values = JSON.stringify({ slope: cdl.slope, offset: cdl.offset, power: cdl.power, sat: cdl.sat });
    const existing = this.rows<Record<string, SqlValue>>('select id, grade from lut where name = ?', [fileName])[0];
    if (existing) {
      if (Number(existing['grade']) !== 1) throw new Error(`${fileName} is an imported LUT. Save the grade under another name.`);
      const id = Number(existing['id']);
      this.transaction(() =>
        this.run('update lut set content = ?, cdl = ?, grade_base = ?, title = ?, imported_at = ? where id = ?', [cube, values, baseLutId, title, now(), id]),
      );
      return id;
    }
    const id = this.addLut(fileName, { format: 'cube', kind: '3D', size: 33, title }, cube, values);
    this.transaction(() => this.run('update lut set grade = 1, grade_base = ? where id = ?', [baseLutId, id]));
    return id;
  }

  /** Add a LUT to the library: checked first; the same name with different contents is refused, not replaced. */
  importLut(fileName: string, content: string): number {
    // An ASC CDL: each correction in it becomes a look of its own, baked to a .cube for the dailies.
    if (isCdlFile(fileName)) {
      const corrections = parseCdl(fileName, content);
      let first = 0;
      for (const cdl of corrections) {
        const name = corrections.length === 1 ? fileName : `${cdl.id}.cc`;
        const id = this.addLut(name, { format: 'cube', kind: '3D', size: 33, title: cdl.description || cdl.id }, cdlCube(cdl), JSON.stringify({ slope: cdl.slope, offset: cdl.offset, power: cdl.power, sat: cdl.sat }));
        first ||= id;
      }
      return first;
    }
    return this.addLut(fileName, parseLut(fileName, content), content, null);
  }

  private addLut(fileName: string, info: { format: string; kind: string; size: number; title: string }, content: string, cdl: string | null): number {
    const existing = this.rows<Record<string, SqlValue>>('select id, content from lut where name = ?', [fileName])[0];
    if (existing) {
      if (String(existing['content']) === content) return Number(existing['id']);
      throw new Error(`A different ${fileName} is already in the library. Rename the new one (e.g. _v2) to keep both.`);
    }
    this.transaction(() =>
      this.run('insert into lut (name, format, kind, size, title, content, imported_at, cdl) values (?, ?, ?, ?, ?, ?, ?, ?)', [
        fileName,
        info.format,
        info.kind,
        info.size,
        info.title,
        content,
        now(),
        cdl,
      ]),
    );
    const id = Number(this.value<number>('select id from lut where name = ?', [fileName]));
    // The first LUT of a production becomes its default.
    if (!this.rows("select 1 from lut_rule where scope = 'Project'").length) this.setLutRule('Project', 'Default', id);
    return id;
  }

  removeLut(id: number) {
    this.transaction(() => {
      this.run('delete from lut_rule where lut_id = ?', [id]);
      this.run('delete from lut where id = ?', [id]);
    });
  }

  setLutRule(scope: LutScope, target: string, lutId: number) {
    if (!this.rows('select 1 from lut where id = ?', [lutId]).length) throw new Error('That LUT is not in the library.');
    const clean = scope === 'Project' ? 'Default' : target.trim().toUpperCase();
    if (!clean) throw new Error('Say what the rule is for.');
    this.transaction(() => this.run('insert or replace into lut_rule (scope, target, lut_id) values (?, ?, ?)', [scope, clean, lutId]));
  }

  removeLutRule(id: number) {
    this.transaction(() => this.run('delete from lut_rule where id = ?', [id]));
  }

  /** The CDL numbers of each look that is an ASC CDL, by look id. */
  private cdls(): Map<number, Cdl> {
    return new Map(
      this.rows<Record<string, SqlValue>>('select id, cdl from lut where cdl is not null').map((row) => [Number(row['id']), JSON.parse(String(row['cdl'])) as Cdl]),
    );
  }

  private rules(): { id: number; scope: LutScope; target: string; lutId: number; lut: string }[] {
    return this.rows<Record<string, SqlValue>>('select r.id, r.scope, r.target, r.lut_id, l.name from lut_rule r join lut l on l.id = r.lut_id').map((row) => ({
      id: Number(row['id']),
      scope: row['scope'] as LutScope,
      target: String(row['target']),
      lutId: Number(row['lut_id']),
      lut: String(row['name']),
    }));
  }

  /** The rule that decides a clip's look: the most specific that applies. */
  private ruleFor(rules: ReturnType<ProductionDb['rules']>, day: number, shot: { scene: string; setup: string; clip: string }) {
    const targets: Record<LutScope, string> = {
      Clip: shot.clip,
      Setup: `${shot.scene}/${shot.setup}`,
      Scene: shot.scene,
      Day: String(day),
      Camera: shot.clip[0] ?? '',
      Project: 'Default',
    };
    for (const scope of LUT_SCOPES) {
      const rule = rules.find((candidate) => candidate.scope === scope && candidate.target.toUpperCase() === targets[scope].toUpperCase());
      if (rule) return rule;
    }
    return null;
  }

  /** Where each of the day's camera clips sits in the log: scene and setup. */
  private clipShots(day: number): Map<string, { scene: string; setup: string; take: string }> {
    return new Map(
      this.rows<Record<string, SqlValue>>(
        `select m.clip_card, m.clip_key, e.scene, e.setup, e.take from script_match m join script_entry e on e.id = m.entry_id
         where e.day = ? and m.state = 'matched' and m.clip_key is not null and m.decided != 'wild'`,
        [day],
      ).map((row) => [
        `${String(row['clip_card'])}|${String(row['clip_key'])}`,
        { scene: String(row['scene']), setup: String(row['setup']), take: String(row['take']) },
      ]),
    );
  }

  lutRules(day: number): LutRuleEntry[] {
    const rules = this.rules();
    const shots = this.clipShots(day);
    const counts = new Map<number, number>();
    for (const picture of this.syncMedia(day).pictures) {
      const shot = shots.get(`${picture.card}|${picture.key}`);
      const rule = this.ruleFor(rules, day, { scene: shot?.scene ?? '', setup: shot?.setup ?? '', clip: picture.key });
      if (rule) counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
    }
    return rules
      .sort((a, b) => LUT_SCOPES.indexOf(b.scope) - LUT_SCOPES.indexOf(a.scope) || a.target.localeCompare(b.target))
      .map((rule) => ({ ...rule, clips: counts.get(rule.id) ?? 0 }));
  }

  /** A LUT's file, for FFmpeg. */
  lutFile(id: number): { name: string; format: 'cube' | '3dl'; content: string } | null {
    const row = this.rows<Record<string, SqlValue>>('select name, format, content from lut where id = ?', [id])[0];
    return row ? { name: String(row['name']), format: row['format'] as 'cube' | '3dl', content: String(row['content']) } : null;
  }

  /** The day's camera clips with something to preview, labelled by their take where the log has one. */
  previewClips(day: number): { id: string; label: string; paths: string[]; meta: MediaMeta | null; lutId: number | null }[] {
    const shots = this.clipShots(day);
    const rules = this.rules();
    return this.syncMedia(day)
      .pictures.filter((picture) => picture.meta?.kind === 'picture')
      .map((picture) => {
        const shot = shots.get(`${picture.card}|${picture.key}`);
        return {
          id: `${picture.card}|${picture.key}`,
          label: shot ? `${picture.key} · Sc ${shot.scene} / ${shot.setup || '—'} / T${shot.take.padStart(2, '0')}` : picture.key,
          paths: picture.paths,
          meta: picture.meta,
          lutId: this.ruleFor(rules, day, { scene: shot?.scene ?? '', setup: shot?.setup ?? '', clip: picture.key })?.lutId ?? null,
        };
      });
  }

  // ------------------------------------------------ dailies

  dailiesSettings(): DailiesSettings {
    const raw = this.value<string>('select dailies from production where id = 1');
    const saved = raw ? (JSON.parse(raw) as Partial<DailiesSettings>) : {};
    return { ...DEFAULT_DAILIES, ...saved, burnIns: { ...DEFAULT_DAILIES.burnIns, ...saved.burnIns } };
  }

  saveDailiesSettings(settings: DailiesSettings) {
    this.transaction(() => this.run('update production set dailies = ? where id = 1', [JSON.stringify(settings)]));
  }

  /** The takes the settings ask for, each camera clip with its media, synced sound and look. */
  dailiesPlan(day: number, settings: DailiesSettings): DailyPlan[] {
    const entries = this.logEntries(day);
    const matches = this.rows<Record<string, SqlValue>>(
      `select m.entry_id, m.clip_key, m.clip_card from script_match m join script_entry e on e.id = m.entry_id
       where e.day = ? and m.state = 'matched' and m.clip_key is not null and m.decided != 'wild' order by e.position, m.ref_index`,
      [day],
    );
    const pictures = new Map(this.syncMedia(day).pictures.map((picture) => [`${picture.card}|${picture.key}`, picture]));
    const syncs = new Map(this.syncRecords(day).map((record) => [`${record.card}|${record.clipKey}`, record]));
    const rules = this.rules();
    const projectRule = rules.find((rule) => rule.scope === 'Project') ?? null;
    const plans: DailyPlan[] = [];
    const seen = new Set<string>();
    for (const match of matches) {
      const entry = entries.find((candidate) => candidate.id === Number(match['entry_id']));
      if (!entry) continue;
      const wanted = settings.include === 'all' || (settings.include === 'circle' ? entry.circle || entry.print : settings.scenes.includes(entry.scene));
      if (!wanted) continue;
      const card = String(match['clip_card']);
      const clip = String(match['clip_key']);
      const id = `${card}|${clip}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const picture = pictures.get(id);
      const record = syncs.get(id);
      let sound: DailyPlan['sound'] = null;
      if (record && record.method !== 'None' && record.soundKey && record.soundCard && record.alignFrames !== null) {
        const file = this.rows<Record<string, SqlValue>>("select path, meta from clip where day = ? and card = ? and kind = 'sound' order by path", [day, record.soundCard]).find(
          (row) => String(row['path']).split('/').pop()!.replace(/\.[^.]+$/, '') === record.soundKey,
        );
        if (file) {
          const parsed = file['meta'] ? (JSON.parse(String(file['meta'])) as MetaResult) : null;
          sound = {
            key: record.soundKey,
            paths: this.copiesOf(day, record.soundCard, String(file['path'])),
            alignFrames: record.alignFrames,
            channels: parsed?.ok ? (parsed.meta.channels ?? 1) : 1,
            accepted: record.accepted,
          };
        }
      }
      const rule =
        settings.look === 'None · LOG original'
          ? null
          : settings.look === 'Project default only'
            ? projectRule
            : this.ruleFor(rules, day, { scene: entry.scene, setup: entry.setup, clip });
      const take = entry.take.padStart(2, '0');
      plans.push({
        takeId: `${entry.scene}|${entry.setup || '—'}|${entry.take}`,
        label: `${entry.scene}${entry.setup}-${take}`,
        scene: entry.scene,
        setup: entry.setup,
        take,
        clip,
        card,
        circle: entry.circle || entry.print,
        notes: entry.notes,
        clipPaths: picture?.paths ?? [],
        meta: picture?.meta ?? null,
        metaError: picture?.metaError ?? null,
        sound,
        lut: rule ? this.lutFile(rule.lutId) : null,
      });
    }
    return plans;
  }

  saveRender(day: number, plan: Pick<DailyPlan, 'takeId' | 'clip' | 'card'>, render: DailyRender & { checksum: string | null }) {
    this.transaction(() =>
      this.run(
        `insert or replace into dailies_render (day, take_id, clip_key, card, label, output, state, error, lut, codec, bytes, checksum, warnings, made_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          day,
          plan.takeId,
          plan.clip,
          plan.card,
          render.label,
          render.output,
          render.state,
          render.error,
          render.lut,
          render.codec,
          render.bytes,
          render.checksum,
          JSON.stringify(render.warnings),
          now(),
        ],
      ),
    );
  }

  renders(day: number): (DailyRender & { checksum: string | null })[] {
    const project = this.frameioTarget()?.projectId ?? null;
    const published = new Map(
      this.rows<Record<string, SqlValue>>('select * from frameio_upload where day = ?', [day]).map((row) => [`${String(row['take_id'])}|${String(row['clip_key'])}`, row]),
    );
    return this.rows<Record<string, SqlValue>>('select * from dailies_render where day = ? order by label, clip_key', [day]).map((row) => ({
      ...this.publishedAs(published.get(`${String(row['take_id'])}|${String(row['clip_key'])}`), project, (row['checksum'] as string | null) ?? null),
      takeId: String(row['take_id']),
      label: String(row['label']),
      clip: String(row['clip_key']),
      output: String(row['output']),
      state: row['state'] as DailyRender['state'],
      error: (row['error'] as string | null) ?? null,
      lut: (row['lut'] as string | null) ?? null,
      codec: String(row['codec']),
      bytes: (row['bytes'] as number | null) ?? null,
      checksum: (row['checksum'] as string | null) ?? null,
      warnings: JSON.parse(String(row['warnings'])) as string[],
    }));
  }

  /** A daily's Frame.io record, when it is of this render (same checksum) in the project published to now. */
  private publishedAs(row: Record<string, SqlValue> | undefined, project: string | null, checksum: string | null): { frameio?: DailyRender['frameio'] } {
    if (!row || String(row['project_id']) !== project || (row['checksum'] ?? null) !== checksum) return {};
    return { frameio: { state: row['state'] as 'done' | 'failed', error: (row['error'] as string | null) ?? null, viewUrl: (row['view_url'] as string | null) ?? null } };
  }

  // ------------------------------------------------ Frame.io

  frameioTarget(): FrameioTarget | null {
    const raw = this.value<string>('select frameio from production where id = 1');
    return raw ? (JSON.parse(raw) as FrameioTarget) : null;
  }

  saveFrameioTarget(target: FrameioTarget | null) {
    this.transaction(() => this.run('update production set frameio = ? where id = 1', [target ? JSON.stringify(target) : null]));
  }

  /** What was last published for a daily: its file on Frame.io, which render (checksum), and how it went. */
  frameioUpload(day: number, takeId: string, clip: string): { projectId: string; fileId: string | null; checksum: string | null; state: 'done' | 'failed' } | null {
    const row = this.rows<Record<string, SqlValue>>('select project_id, file_id, checksum, state from frameio_upload where day = ? and take_id = ? and clip_key = ?', [day, takeId, clip])[0];
    return row
      ? { projectId: String(row['project_id']), fileId: (row['file_id'] as string | null) ?? null, checksum: (row['checksum'] as string | null) ?? null, state: row['state'] as 'done' | 'failed' }
      : null;
  }

  saveFrameioUpload(
    day: number,
    takeId: string,
    clip: string,
    record: { projectId: string; fileId: string | null; name: string; bytes: number; checksum: string | null; state: 'done' | 'failed'; error: string | null; viewUrl: string | null },
  ) {
    this.transaction(() =>
      this.run(
        `insert or replace into frameio_upload (day, take_id, clip_key, project_id, file_id, name, bytes, checksum, state, error, view_url, at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [day, takeId, clip, record.projectId, record.fileId, record.name, record.bytes, record.checksum, record.state, record.error, record.viewUrl, now()],
      ),
    );
  }

  // ------------------------------------------------ delivery

  deliverySettings(): DeliverySettings {
    const raw = this.value<string>('select delivery from production where id = 1');
    return raw ? { ...DEFAULT_DELIVERY, ...(JSON.parse(raw) as Partial<DeliverySettings>) } : { ...DEFAULT_DELIVERY };
  }

  saveDeliverySettings(settings: DeliverySettings) {
    this.transaction(() => this.run('update production set delivery = ? where id = 1', [JSON.stringify(settings)]));
  }

  saveDelivery(day: number, record: StoredDelivery) {
    this.transaction(() =>
      this.run(
        `insert or replace into delivery_record (day, package, leg_id, destination, root, source, files, bytes, verified, already_there, failed,
           retries, started_at, finished_at, problems, failed_files, mhl)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          day,
          record.package,
          record.destinationId,
          record.destination,
          record.root,
          record.source,
          record.files,
          record.bytes,
          record.verified,
          record.alreadyThere,
          record.failed,
          record.retries,
          record.startedAt,
          record.finishedAt,
          JSON.stringify(record.problems),
          JSON.stringify(record.failedFiles),
          record.mhl,
        ],
      ),
    );
  }

  deliveries(day: number): StoredDelivery[] {
    const order = DELIVERY_PACKAGES.map((pkg) => pkg.id);
    return this.rows<Record<string, SqlValue>>('select * from delivery_record where day = ? order by finished_at', [day])
      .map((row) => {
        const id = row['package'] as DeliveryPackageId;
        return {
          package: id,
          packageName: DELIVERY_PACKAGES.find((pkg) => pkg.id === id)?.name ?? id,
          destinationId: String(row['leg_id']),
          destination: String(row['destination']),
          root: String(row['root']),
          source: String(row['source']),
          files: Number(row['files']),
          bytes: Number(row['bytes']),
          verified: Number(row['verified']),
          alreadyThere: Number(row['already_there']),
          failed: Number(row['failed']),
          retries: Number(row['retries']),
          startedAt: String(row['started_at']),
          finishedAt: String(row['finished_at']),
          problems: JSON.parse(String(row['problems'])) as DeliveryRecord['problems'],
          failedFiles: JSON.parse(String(row['failed_files'])) as DeliveryFile[],
          mhl: (row['mhl'] as string | null) ?? null,
        };
      })
      .sort((a, b) => order.indexOf(a.package) - order.indexOf(b.package) || a.destination.localeCompare(b.destination));
  }

  /**
   * The checksum each of the day's originals was ingested with, by its path
   * in the day folder (CAMERA_ORIGINALS/A015/…), for the method given: a
   * delivery checks the copy it reads against it.
   */
  ingestHashes(day: number, method: ChecksumMethod): Map<string, string> {
    const hashes = new Map<string, string>();
    for (const row of this.rows<Record<string, SqlValue>>(
      'select card, path, kind, checksum from clip where day = ? and checksum is not null and checksum_method = ?',
      [day, method],
    )) {
      const folder = row['kind'] === 'sound' ? 'SOUND_ORIGINALS' : 'CAMERA_ORIGINALS';
      hashes.set(`${folder}/${segment(String(row['card']))}/${String(row['path'])}`, String(row['checksum']));
    }
    return hashes;
  }

  /** Every camera clip of the day with its take, timecode, sync and look: what the ALE and sync list say. */
  editorialRows(day: number): EditorialRow[] {
    const entries = new Map(this.logEntries(day).map((entry) => [entry.id, entry]));
    const takes = new Map<string, StoredEntry>();
    for (const row of this.rows<Record<string, SqlValue>>(
      `select m.entry_id, m.clip_card, m.clip_key from script_match m join script_entry e on e.id = m.entry_id
       where e.day = ? and m.state = 'matched' and m.clip_key is not null and m.decided != 'wild' order by e.position`,
      [day],
    )) {
      const entry = entries.get(Number(row['entry_id']));
      const id = `${String(row['clip_card'])}|${String(row['clip_key'])}`;
      if (entry && !takes.has(id)) takes.set(id, entry);
    }
    const syncs = new Map(this.syncRecords(day).map((record) => [`${record.card}|${record.clipKey}`, record]));
    const files = new Map<string, string>();
    const sounds = new Map<string, string>();
    for (const row of this.rows<Record<string, SqlValue>>('select card, file_name, kind from clip where day = ? order by path', [day])) {
      const name = String(row['file_name']);
      if (row['kind'] === 'camera' && isPictureFile(name)) {
        const id = `${String(row['card'])}|${pictureKey(name)}`;
        if (!files.has(id)) files.set(id, name);
      } else if (row['kind'] === 'sound' && AUDIO_FILE.test(name)) {
        sounds.set(`${String(row['card'])}|${name.replace(/\.[^.]+$/, '')}`, name);
      }
    }
    const rules = this.rules();
    const media = this.syncMedia(day);
    const soundMedia = new Map(media.sounds.map((sound) => [`${sound.card}|${sound.key}`, sound]));
    const cdls = this.cdls();
    return media
      .pictures.map((picture) => {
        const id = `${picture.card}|${picture.key}`;
        const entry = takes.get(id);
        const sync = syncs.get(id);
        const synced = sync && sync.method !== 'None' && sync.soundKey;
        const rule = this.ruleFor(rules, day, { scene: entry?.scene ?? '', setup: entry?.setup ?? '', clip: picture.key });
        return {
          clip: picture.key,
          card: picture.card,
          file: files.get(id) ?? picture.key,
          tc: picture.meta?.tc ? { frames: picture.meta.tc.frames, base: picture.meta.tc.base, dropFrame: picture.meta.tc.dropFrame } : null,
          rate: picture.meta?.rate ?? null,
          durationSec: picture.meta?.durationSec ?? null,
          scene: entry?.scene ?? '',
          setup: entry?.setup ?? '',
          take: entry?.take ?? '',
          circle: Boolean(entry && (entry.circle || entry.print)),
          notes: entry?.notes ?? '',
          roll: entry?.roll || picture.card,
          soundRoll: synced ? (entry?.soundRoll || sync.soundCard || '') : '',
          soundFile: synced ? (sounds.get(`${sync.soundCard}|${sync.soundKey}`) ?? sync.soundKey!) : '',
          sync: synced ? `${sync.method}${sync.accepted ? '' : ' (not reviewed)'}` : 'None',
          syncFrames: synced ? sync.alignFrames : null,
          look: rule?.lut ?? '',
          cdl: rule ? (cdls.get(rule.lutId) ?? null) : null,
          paths: picture.paths,
          ...(() => {
            const sound = synced ? soundMedia.get(`${sync.soundCard}|${sync.soundKey}`) : undefined;
            return {
              soundPaths: sound?.paths ?? [],
              soundChannels: sound?.meta?.channels ?? null,
              sampleRate: sound?.meta?.sampleRate ?? null,
              soundStartSec: sound?.meta?.soundStartSec ?? null,
              soundDurationSec: sound?.meta?.durationSec ?? null,
            };
          })(),
        };
      })
      .sort((a, b) => a.card.localeCompare(b.card) || a.clip.localeCompare(b.clip));
  }

  // ------------------------------------------------ notes

  notes(day: number): DayNote[] {
    return this.rows<Record<string, SqlValue>>('select * from day_note where day = ? order by at, id', [day]).map((row) => ({
      id: Number(row['id']),
      tc: (row['tc'] as string | null) ?? null,
      tcSource: row['tc_source'] as DayNote['tcSource'],
      rate: String(row['rate']),
      at: String(row['at']),
      scope: row['scope'] as DayNote['scope'],
      scene: String(row['scene']),
      setup: String(row['setup']),
      take: String(row['take']),
      clip: String(row['clip']),
      text: String(row['body']),
      screen: String(row['screen']),
    }));
  }

  addNote(day: number, note: NoteInput): number {
    let id = 0;
    this.transaction(() => {
      this.run('insert into day_note (day, tc, tc_source, rate, at, scope, scene, setup, take, clip, body, screen) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        day,
        note.tc,
        note.tcSource,
        note.rate,
        note.at,
        note.scope,
        note.scene,
        note.setup,
        note.take,
        note.clip,
        note.text,
        note.screen,
      ]);
      id = this.value<number>('select last_insert_rowid()') ?? 0;
    });
    return id;
  }

  /** What the note says and what it is about; when and at what timecode it was made stay as they were. */
  updateNote(day: number, id: number, patch: Partial<Pick<DayNote, 'text' | 'scope' | 'scene' | 'setup' | 'take' | 'clip'>>) {
    const note = this.notes(day).find((candidate) => candidate.id === id);
    if (!note) throw new Error('That note is no longer there.');
    const next = { ...note, ...patch };
    this.transaction(() =>
      this.run('update day_note set body = ?, scope = ?, scene = ?, setup = ?, take = ?, clip = ? where id = ? and day = ?', [
        next.text,
        next.scope,
        next.scene,
        next.setup,
        next.take,
        next.clip,
        id,
        day,
      ]),
    );
  }

  removeNote(day: number, id: number) {
    this.transaction(() => this.run('delete from day_note where id = ? and day = ?', [id, day]));
  }

  /** How many camera and sound files the day has, from how many cards, and the drive its first card went to. */
  mediaCounts(day: number): ProjectState['media'] {
    const count = (kind: string) => this.value<number>('select count(*) from clip where day = ? and kind = ?', [day, kind]) ?? 0;
    return {
      cameraFiles: count('camera'),
      soundFiles: count('sound'),
      cards: this.value<number>('select count(distinct card) from clip where day = ?', [day]) ?? 0,
      home: this.value<string>(
        `select d.name from transfer_destination d join transfer t on t.day = d.day and t.id = d.transfer_id
         where d.day = ? order by t.started_at, t.id, d.position limit 1`,
        [day],
      ),
    };
  }


  // ------------------------------------------------ relinking copies that moved

  /** Every copy the production made, on every day: where each card's folder was written. */
  copyLocations(): { day: number; transferId: string; legId: string; card: string; name: string; root: string; targetDir: string }[] {
    return this.rows<Record<string, SqlValue>>(
      `select d.day, d.transfer_id, d.leg_id, t.card, d.name, d.root, d.target_dir
       from transfer_destination d join transfer t on t.day = d.day and t.id = d.transfer_id
       order by d.day, t.started_at, d.position`,
    ).map((row) => ({
      day: Number(row['day']),
      transferId: String(row['transfer_id']),
      legId: String(row['leg_id']),
      card: String(row['card']),
      name: String(row['name']),
      root: String(row['root']),
      targetDir: String(row['target_dir']),
    }));
  }

  /** A drive's copies (by its name and where it was), each with the files that verified there: what a relink proves. */
  relinkLegs(name: string, root: string): RelinkLeg[] {
    const legs = this.rows<Record<string, SqlValue>>(
      `select d.day, d.transfer_id, d.leg_id, t.card, d.name, d.root, d.target_dir, d.reports_dir
       from transfer_destination d join transfer t on t.day = d.day and t.id = d.transfer_id
       where d.name = ? and d.root = ? order by d.day, t.started_at`,
      [name, root],
    );
    return legs.map((leg) => ({
      day: Number(leg['day']),
      transferId: String(leg['transfer_id']),
      legId: String(leg['leg_id']),
      card: String(leg['card']),
      name: String(leg['name']),
      root: String(leg['root']),
      targetDir: String(leg['target_dir']),
      reportsDir: String(leg['reports_dir']),
      files: this.rows<Record<string, SqlValue>>(
        `select c.path, c.size, c.checksum, c.checksum_method from clip c join clip_copy cc on cc.clip_id = c.id
         where c.day = ? and c.transfer_id = ? and cc.leg_id = ? and cc.state in ('verified', 'already-there')`,
        [Number(leg['day']), String(leg['transfer_id']), String(leg['leg_id'])],
      ).map((file) => ({
        path: String(file['path']),
        size: Number(file['size']),
        hash: (file['checksum'] as string | null) ?? null,
        method: file['checksum_method'] as ChecksumMethod,
      })),
    }));
  }

  /**
   * Point copies at where they are now. A copy known by its drive's old place
   * (a volume's mount path, a folder's) is known by the new one, so the drive
   * at its new place is recognised as the one holding it.
   */
  relink(found: RelinkFound[]) {
    this.transaction(() => {
      for (const { leg, root, targetDir, reportsDir } of found) {
        const legId = leg.legId === leg.root ? root : leg.legId === `folder:${leg.root}` ? `folder:${root}` : leg.legId;
        const clash = legId !== leg.legId && this.rows('select 1 from transfer_destination where day = ? and transfer_id = ? and leg_id = ?', [leg.day, leg.transferId, legId]).length > 0;
        const id = clash ? leg.legId : legId;
        this.run('update transfer_destination set root = ?, target_dir = ?, reports_dir = ?, leg_id = ? where day = ? and transfer_id = ? and leg_id = ?', [
          root,
          targetDir,
          reportsDir,
          id,
          leg.day,
          leg.transferId,
          leg.legId,
        ]);
        if (id === leg.legId) continue;
        this.run('update transfer_destination set relay_from = ? where day = ? and transfer_id = ? and relay_from = ?', [id, leg.day, leg.transferId, leg.legId]);
        this.run('update clip_copy set leg_id = ? where leg_id = ? and clip_id in (select id from clip where day = ? and transfer_id = ?)', [id, leg.legId, leg.day, leg.transferId]);
      }
    });
  }

  // ------------------------------------------------ sealing a drive

  /**
   * Every file copied to a drive and verified there, on every day: what a
   * seal checks the drive against. The drive is known by where it is mounted
   * or by its name (a drive letter can change between days); each card
   * folder is kept relative to the drive, so either way it is found.
   */
  sealExpectations(root: string, name: string): SealExpected[] {
    const rows = this.rows<Record<string, SqlValue>>(
      `select c.day, c.card, c.path, c.size, c.checksum, c.checksum_method, d.root, d.target_dir
       from clip c
       join transfer_destination d on d.day = c.day and d.transfer_id = c.transfer_id
       join clip_copy cc on cc.clip_id = c.id and cc.leg_id = d.leg_id
       where cc.state in ('verified', 'already-there') and (d.root = ? or d.name = ?)
       order by c.day, c.id`,
      [root, name],
    );
    const out: SealExpected[] = [];
    for (const row of rows) {
      const dir = relative(String(row['root']), String(row['target_dir'])).split(sep).join('/');
      if (!dir || dir.startsWith('..') || isAbsolute(dir)) continue;
      out.push({
        day: Number(row['day']),
        card: String(row['card']),
        dir,
        path: String(row['path']),
        size: Number(row['size']),
        hash: (row['checksum'] as string | null) ?? null,
        method: row['checksum_method'] as ChecksumMethod,
      });
    }
    return out;
  }

  recordSeal(seal: Omit<DriveSeal, 'stale'>) {
    this.run('insert into drive_seal (root, name, sealed_at, files, bytes, verified, manifest) values (?, ?, ?, ?, ?, ?, ?)', [
      seal.root,
      seal.name,
      seal.sealedAt,
      seal.files,
      seal.bytes,
      seal.verified ? 1 : 0,
      seal.manifest,
    ]);
    this.changed();
  }

  /** Each drive's last seal, and whether a transfer to it finished after. */
  seals(): DriveSeal[] {
    return this.rows<Record<string, SqlValue>>(
      `select s.*, exists (
         select 1 from transfer t join transfer_destination d on d.day = t.day and d.transfer_id = t.id
         where (d.root = s.root or d.name = s.name) and t.finished_at > s.sealed_at
       ) as stale
       from drive_seal s
       where s.id = (select max(id) from drive_seal x where x.root = s.root and x.name = s.name)
       order by s.sealed_at desc`,
    ).map((row) => ({
      root: String(row['root']),
      name: String(row['name']),
      sealedAt: String(row['sealed_at']),
      files: Number(row['files']),
      bytes: Number(row['bytes']),
      verified: Number(row['verified']) === 1,
      manifest: (row['manifest'] as string | null) ?? null,
      stale: Number(row['stale']) === 1,
    }));
  }

  // ------------------------------------------------ takes: where each clip goes

  /** The day's camera report, card by card, in the order it was written. */
  cameraReport(day: number): CameraReportRow[] {
    return this.rows<Record<string, SqlValue>>('select * from camera_report where day = ? order by card, position, id', [day]).map((row) => ({
      id: Number(row['id']),
      card: String(row['card']),
      clip: String(row['clip']),
      scene: String(row['scene']),
      setup: String(row['setup']),
      take: String(row['take']),
      circle: Number(row['circle']) === 1,
      lens: String(row['lens']),
      notes: String(row['notes']),
      source: row['source'] as CameraReportRow['source'],
    }));
  }

  /** One card's camera report, as entered or imported: it replaces what that card had. */
  setCameraReport(day: number, card: string, rows: CameraReportInput[], source: CameraReportRow['source'] = 'entered') {
    this.transaction(() => {
      this.run('delete from camera_report where day = ? and card = ?', [day, card]);
      for (const [position, row] of rows.entries()) {
        this.run(
          'insert into camera_report (day, card, clip, scene, setup, take, circle, lens, notes, source, position) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [day, card, row.clip, row.scene, row.setup, takeNumber(row.take), row.circle ? 1 : 0, row.lens, row.notes, source, position],
        );
      }
    });
  }

  /**
   * A camera report file (CSV, tab-separated, ALE…: read like a script log)
   * into the day's report, card by card. A row names its card in a roll or
   * card column, or in a full clip name; one that names neither is skipped.
   */
  importCameraReport(day: number, entries: LogEntry[], source: CameraReportRow['source'] = 'csv'): { cards: string[]; rows: number; skipped: string[] } {
    const byCard = new Map<string, CameraReportInput[]>();
    const skipped: string[] = [];
    for (const entry of entries) {
      const refs = entry.clipRefs.length ? entry.clipRefs : [''];
      for (const ref of refs) {
        const card = (entry.roll || reportClipKey('', ref)?.slice(0, 4) || '').toUpperCase().trim();
        if (!card || !ref) {
          skipped.push(`Line ${entry.line}: ${!card ? 'no card or roll' : 'no clip'} — skipped.`);
          continue;
        }
        const rows = byCard.get(card) ?? [];
        rows.push({ card, clip: ref, scene: entry.scene, setup: entry.setup, take: entry.take, circle: entry.circle || entry.print, lens: entry.lens, notes: entry.notes });
        byCard.set(card, rows);
      }
    }
    for (const [card, rows] of byCard) this.setCameraReport(day, card, rows, source);
    return { cards: [...byCard.keys()], rows: [...byCard.values()].reduce((sum, rows) => sum + rows.length, 0), skipped };
  }

  /**
   * The day's camera report from VC Film Studio, roll by roll. A roll whose
   * report was typed here or imported from a file is kept as it is — the DIT
   * chose that over Film Studio's — and named, so the screen can say so. A
   * roll Film Studio no longer has is taken out, if it came from Film Studio.
   */
  pullCameraReport(day: number, lines: CameraReportInput[]): { cards: string[]; rows: number; kept: string[]; removed: string[] } {
    const byCard = new Map<string, CameraReportInput[]>();
    for (const line of lines) byCard.set(line.card, [...(byCard.get(line.card) ?? []), line]);
    const sourceOf = new Map<string, Set<CameraReportRow['source']>>();
    for (const row of this.cameraReport(day)) sourceOf.set(row.card, (sourceOf.get(row.card) ?? new Set()).add(row.source));
    const local = (card: string) => [...(sourceOf.get(card) ?? [])].some((source) => source !== 'film-studio');
    const cards: string[] = [];
    const kept: string[] = [];
    let rows = 0;
    // Roll by roll: each one is replaced whole, in its own transaction.
    for (const [card, cardLines] of byCard) {
      if (local(card)) {
        kept.push(card);
        continue;
      }
      this.setCameraReport(day, card, cardLines, 'film-studio');
      cards.push(card);
      rows += cardLines.length;
    }
    const removed = [...sourceOf.keys()].filter((card) => !byCard.has(card) && !local(card));
    if (removed.length) {
      this.transaction(() => {
        for (const card of removed) this.run('delete from camera_report where day = ? and card = ? and source = ?', [day, card, 'film-studio']);
      });
    }
    return { cards, rows, kept, removed };
  }

  /** The DIT's own word on where clips go (null: back to what the sources say). */
  assignClips(day: number, clips: { card: string; clip: string }[], slate: SlateInput | null, how: 'manual' | 'decided' | 'none' = 'manual') {
    this.transaction(() => {
      for (const { card, clip } of clips) {
        if (slate === null && how !== 'none') {
          this.run('delete from clip_assign where day = ? and card = ? and clip_key = ?', [day, card, clip]);
          continue;
        }
        this.run(
          'insert or replace into clip_assign (day, card, clip_key, scene, setup, take, circle, how, made_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [day, card, clip, slate?.scene.trim().toUpperCase() ?? '', slate?.setup.trim().toUpperCase() ?? '', slate ? takeNumber(slate.take) : '', slate?.circle ? 1 : 0, how, now()],
        );
      }
    });
  }

  /** The day's camera clips, one per clip (a clip spanning files counts once), card by card. */
  private dayCameraClips(day: number): { card: string; clip: string }[] {
    const clips = new Map<string, { card: string; clip: string }>();
    for (const row of this.rows<Record<string, SqlValue>>("select card, file_name from clip where day = ? and kind = 'camera' order by card, path", [day])) {
      const name = String(row['file_name']);
      if (!isPictureFile(name)) continue;
      const card = String(row['card']);
      const clip = pictureKey(name);
      if (!clips.has(`${card}|${clip}`)) clips.set(`${card}|${clip}`, { card, clip });
    }
    return [...clips.values()];
  }

  /** Every clip of the day with what each source says about it, and where that puts it. */
  assignments(day: number): Assignment[] {
    const claims = new Map<string, Claim[]>();
    const add = (card: string, clip: string, claim: Claim) => {
      const id = `${card}|${clip}`;
      claims.set(id, [...(claims.get(id) ?? []), claim]);
    };

    // The script log.
    const entries = new Map(this.logEntries(day).map((entry) => [entry.id, entry]));
    for (const row of this.rows<Record<string, SqlValue>>(
      `select m.entry_id, m.clip_card, m.clip_key from script_match m join script_entry e on e.id = m.entry_id
       where e.day = ? and m.state = 'matched' and m.clip_key is not null and m.decided != 'wild' order by e.position, m.ref_index`,
      [day],
    )) {
      const entry = entries.get(Number(row['entry_id']));
      if (!entry) continue;
      const card = String(row['clip_card']);
      const clip = String(row['clip_key']);
      if (claims.get(`${card}|${clip}`)?.some((claim) => claim.source === 'log')) continue;
      add(card, clip, { source: 'log', scene: entry.scene, setup: entry.setup, take: entry.take, circle: entry.circle || entry.print, from: `Script log line ${entry.line}` });
    }

    // The camera report: its row's clip on its card.
    const cardClips = new Map<string, Set<string>>();
    for (const { card, clip } of this.dayCameraClips(day)) cardClips.set(card, (cardClips.get(card) ?? new Set()).add(clip));
    for (const [index, row] of this.cameraReport(day).entries()) {
      const key = reportClipKey(row.card, row.clip);
      if (!key || !cardClips.get(row.card)?.has(key)) continue;
      add(row.card, key, { source: 'report', scene: row.scene, setup: row.setup, take: row.take, circle: row.circle, from: `Camera report, ${row.card} line ${index + 1}` });
    }

    // The slate the sound recorder wrote, through the sync that pairs the sound file with the clip.
    const scenes = new Set(this.scenes(day).map((scene) => scene.id.toUpperCase()));
    const sounds = new Map<string, MediaMeta>();
    for (const row of this.rows<Record<string, SqlValue>>("select card, file_name, meta from clip where day = ? and kind = 'sound' and meta is not null", [day])) {
      const parsed = JSON.parse(String(row['meta'])) as MetaResult;
      if (parsed.ok) sounds.set(`${String(row['card'])}|${String(row['file_name']).replace(/\.[^.]+$/, '')}`, parsed.meta);
    }
    for (const record of this.syncRecords(day)) {
      if (!record.soundKey || !record.soundCard || record.method === 'None') continue;
      const ixml = sounds.get(`${record.soundCard}|${record.soundKey}`)?.ixml;
      if (!ixml?.scene || !ixml.take) continue;
      const { scene, setup } = splitSlate(ixml.scene, scenes);
      add(record.card, record.clipKey, { source: 'sound', scene, setup, take: ixml.take, circle: false, from: `Sound file ${record.soundKey}` });
    }

    // The DIT's own word.
    const own = new Map(
      this.rows<Record<string, SqlValue>>('select * from clip_assign where day = ?', [day]).map((row) => [`${String(row['card'])}|${String(row['clip_key'])}`, row]),
    );

    return this.dayCameraClips(day).map(({ card, clip }) => {
      const id = `${card}|${clip}`;
      const said = claims.get(id) ?? [];
      const mine = own.get(id);
      if (mine && mine['how'] === 'none') return { card, clip, slate: null, by: 'manual' as const, claims: said, conflict: false };
      if (mine) {
        const claim: Claim = {
          source: 'manual',
          scene: String(mine['scene']),
          setup: String(mine['setup']),
          take: String(mine['take']),
          circle: Number(mine['circle']) === 1,
          from: mine['how'] === 'decided' ? 'Decided in Match Review' : 'Assigned by the DIT',
        };
        return resolveAssignment(card, clip, [...said, claim]);
      }
      return resolveAssignment(card, clip, said);
    });
  }

  /** What the Assign screen shows: every clip and where it goes, the camera report, and the report checked against the cards. */
  takesView(day: number): TakesState {
    const assignments = this.assignments(day);
    const report = this.cameraReport(day);
    const clips: AssignedClip[] = assignments.map((item) => ({
      card: item.card,
      clip: item.clip,
      scene: item.slate?.scene ?? '',
      setup: item.slate?.setup ?? '',
      take: item.slate?.take ?? '',
      circle: item.slate?.circle ?? false,
      by: item.by,
      conflict: item.conflict,
      claims: item.claims.map(({ source, scene, setup, take, circle, from }) => ({ source, scene, setup, take, circle, from })),
    }));
    // The report against the cards that are in: a row naming a clip not on its card, a clip on a reported card the report leaves out.
    const problems: string[] = [];
    const onCard = new Map<string, Set<string>>();
    for (const { card, clip } of clips) onCard.set(card, (onCard.get(card) ?? new Set()).add(clip));
    const reported = new Map<string, Set<string>>();
    for (const row of report) {
      const key = reportClipKey(row.card, row.clip);
      if (!key) {
        problems.push(`${row.card}: "${row.clip}" is not a clip name VC DIT can read.`);
        continue;
      }
      reported.set(row.card, (reported.get(row.card) ?? new Set()).add(key));
      if (onCard.has(row.card) && !onCard.get(row.card)!.has(key)) problems.push(`${row.card}: the report names ${key} (Sc ${row.scene}${row.setup} T${row.take}), but it is not on the card.`);
    }
    for (const [card, keys] of reported) {
      const missing = [...(onCard.get(card) ?? [])].filter((clip) => !keys.has(clip));
      if (missing.length) problems.push(`${card}: ${missing.length} clip${missing.length === 1 ? '' : 's'} on the card ${missing.length === 1 ? 'is' : 'are'} not in the report (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}).`);
    }
    return { clips, report, reportProblems: problems };
  }

  // ------------------------------------------------ the scene view

  /**
   * Where each camera clip of the day belongs: its take's folder under the
   * scene view (or UNMATCHED by card, until the log names it), and, for a
   * circle take, the same under the selects. Names come from the template.
   */
  organizeViews(day: number): OrganizeView[] {
    const production = this.production();
    const used = new Set<string>();
    const unique = (dir: string, clip: string) => {
      const relDir = used.has(dir.toUpperCase()) ? `${dir}_${segment(clip)}` : dir;
      used.add(relDir.toUpperCase());
      return relDir;
    };
    const views: OrganizeView[] = [];
    for (const { card, clip, slate } of this.assignments(day)) {
      const locations = this.clipLocations(day, card, clip);
      if (locations.length === 0) continue;
      const base = {
        clip,
        card,
        scene: slate?.scene ?? '',
        setup: slate?.setup ?? '',
        take: slate?.take ?? '',
        files: locations[0]!.files.map((file) => ({ path: file.path, size: file.size, hash: file.hash })),
        locations: locations.map(({ legId, name, root, cardDir }) => ({ legId, name, root, cardDir })),
      };
      if (!slate) {
        views.push({ ...base, kind: 'scene', relDir: unique(`${SCENE_VIEW}/UNMATCHED/${segment(card)}/${segment(clip)}`, clip) });
        continue;
      }
      const name = segment(
        applyNaming(production.namingTokens, { prod: production.code || production.name, day, scene: slate.scene, setup: slate.setup, take: slate.take, clip }),
        clip,
      );
      const path = `SCENE_${segment(slate.scene).padStart(3, '0')}/SETUP_${slate.setup ? segment(slate.setup) : 'NONE'}/${name}`;
      views.push({ ...base, kind: 'scene', relDir: unique(`${SCENE_VIEW}/${path}`, clip) });
      if (slate.circle) views.push({ ...base, kind: 'select', relDir: unique(`${SELECTS_VIEW}/${path}`, clip) });
    }
    return views;
  }

  organizeLinks(day: number): OrganizeLink[] {
    return this.rows<Record<string, SqlValue>>('select * from organize_link where day = ? order by kind, card, clip_key', [day]).map((row) => ({
      kind: row['kind'] as OrganizeLink['kind'],
      card: String(row['card']),
      clip: String(row['clip_key']),
      legId: String(row['leg_id']),
      destination: String(row['destination']),
      relDir: String(row['rel_dir']),
      targetDir: String(row['target_dir']),
      cardDir: String(row['card_dir']),
      method: String(row['method']),
      state: row['state'] as OrganizeLink['state'],
      error: (row['error'] as string | null) ?? null,
    }));
  }

  saveOrganize(day: number, link: OrganizeLink) {
    this.transaction(() =>
      this.run(
        `insert or replace into organize_link (day, kind, card, clip_key, leg_id, destination, rel_dir, target_dir, card_dir, method, state, error, made_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [day, link.kind, link.card, link.clip, link.legId, link.destination, link.relDir, link.targetDir, link.cardDir, link.method, link.state, link.error, now()],
      ),
    );
  }

  removeOrganize(day: number, link: Pick<OrganizeLink, 'kind' | 'card' | 'clip' | 'legId'>) {
    this.transaction(() =>
      this.run('delete from organize_link where day = ? and kind = ? and card = ? and clip_key = ? and leg_id = ?', [day, link.kind, link.card, link.clip, link.legId]),
    );
  }

  /** Clips found by name across the whole production, newest day first: the start of the media index. */
  findClips(fileName: string): { day: number; card: string; path: string; checksum: string | null; verifiedCopies: number }[] {
    return this.rows<Record<string, SqlValue>>(
      `select c.day, c.card, c.path, c.checksum,
              (select count(*) from clip_copy cc where cc.clip_id = c.id and cc.state != 'failed') as verified
       from clip c where c.file_name = ? order by c.day desc, c.id`,
      [fileName],
    ).map((row) => ({
      day: Number(row['day']),
      card: String(row['card']),
      path: String(row['path']),
      checksum: (row['checksum'] as string | null) ?? null,
      verifiedCopies: Number(row['verified']),
    }));
  }
}
