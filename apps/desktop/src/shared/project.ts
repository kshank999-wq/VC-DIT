import type { ChecksumMethod } from './media';

/**
 * The production as the local database keeps it (src/main/db) and the
 * screens edit it: settings, shoot days and each day's scene list.
 */

export interface Production {
  name: string;
  code: string;
  frameRate: string;
  checksum: ChecksumMethod;
  totalDays: number;
  devices: { slot: string; name: string; format: string }[];
  /** Naming template tokens, in order, e.g. {PROD}, _, D{DAY}. */
  namingTokens: string[];
  /** How VFX shots are mirrored into the VFX folders (spec §4.9). */
  vfxMethod: MirrorMethod;
}

/**
 * Hard link: the VFX folder's file is the same data as the editorial one, no
 * extra space (same drive, and a filesystem that has links). Reference: a
 * file in the VFX folder saying where the clip is; no media. Physical copy:
 * a separate, verified copy, for a deliverable that must stand alone.
 */
export type MirrorMethod = 'Hard link' | 'Reference' | 'Physical copy';
export const MIRROR_METHODS: MirrorMethod[] = ['Hard link', 'Reference', 'Physical copy'];

export interface ShootDay {
  number: number;
  /** YYYY-MM-DD. */
  date: string;
  /** "Hangar & Rooftop". */
  locations: string;
  operator: { name: string; initials: string };
}

export type SceneStatus = 'Scheduled' | 'Shooting' | 'Shot' | 'Dropped';
export const SCENE_STATUSES: SceneStatus[] = ['Scheduled', 'Shooting', 'Shot', 'Dropped'];

/** A scene on a day's list. Its setups and takes come from the script log and the clips. */
export interface SceneEntry {
  id: string;
  description: string;
  status: SceneStatus;
  notes: string;
  look: string;
}

/** A take as the log and the media make it (spec "Scene / Setup / Take"). */
export interface TakeEntry {
  /** Unique within the day: `${scene}|${setup}|${take}`. */
  id: string;
  /** "T04". */
  take: string;
  /** The A camera's clip ("A015C002"), "—" when there is none yet. */
  clipA: string;
  clipB: string | null;
  sound: string;
  tc: string;
  duration: string;
  circle: boolean;
  vfx: boolean;
  match: 'Matched' | 'Review' | 'Unmatched';
  /** Picture/sound sync; "pending" until the sync step is built. */
  sync: 'TC' | 'WF' | 'none' | 'pending';
}

export interface SetupEntry {
  id: string;
  lens: string;
  takes: TakeEntry[];
}

export interface MatchCandidate {
  clip: string;
  tc: string;
  confidence: number;
  why: string;
}

/** A log entry the DIT has to decide (spec §4.5 Match Review). */
export interface MatchEntry {
  id: string;
  log: string;
  reason: string;
  fields: [string, string][];
  candidates: MatchCandidate[];
  picked: number;
  resolution: null | { kind: 'matched'; clip: string } | { kind: 'wild' };
}

/** One destination's copy of a VFX shot: the editorial clip and its mirror. */
export interface VfxLocation {
  destination: string;
  /** The clip's folder in CAMERA_ORIGINALS. */
  editorial: string;
  /** The take's folder under VFX, once mirrored. */
  mirror: string | null;
  method: MirrorMethod | null;
  state: 'mirrored' | 'failed' | 'pending';
  error: string | null;
}

/** A VFX shot: one camera clip of a take the script supervisor flagged, or the DIT tagged. */
export interface VfxEntry {
  key: string;
  scene: string;
  setup: string;
  /** Two digits: "04". */
  take: string;
  clip: string;
  note: string;
  flaggedBy: 'Script sup.' | 'DIT tag';
  /** Its clip is known (matched in the log). */
  matched: boolean;
  /** Every destination holding a verified copy of the clip. */
  locations: VfxLocation[];
  /** When it was handed to VC VFX Prep. */
  sentAt: string | null;
}

/** One camera clip's sync with production sound (spec "Sync Record"). */
export interface SyncEntry {
  /** `${card}|${clip}`. */
  id: string;
  /** The take it belongs to ("14B-03"), or the clip when the log does not have it. */
  take: string;
  clip: string;
  /** The sound file, or "—". */
  sound: string;
  method: 'Timecode' | 'Waveform' | 'Manual' | 'None';
  /** The correction on top of timecode (or of the waveform's answer), in frames. */
  offsetFrames: number;
  confidence: number;
  accepted: boolean;
  /** The clip's frame rate, for "1 frame @ 23.976 fps". */
  fps: number | null;
  why: string;
  /** Loudness bars of the scratch audio and of the sound as synced, for drawing. */
  barsPicture: number[];
  barsSound: number[];
}

/** A LUT in the production's library (spec §4.7). */
export interface LutEntry {
  id: number;
  name: string;
  title: string;
  kind: '1D' | '3D';
  size: number;
  format: 'cube' | '3dl';
  importedAt: string;
  /** The project-wide rule uses it. */
  isDefault: boolean;
}

export type LutScope = 'Project' | 'Camera' | 'Day' | 'Scene' | 'Setup' | 'Clip';
/** Most specific first: a clip's own rule beats its setup's, and so on down to the project default. */
export const LUT_SCOPES: LutScope[] = ['Clip', 'Setup', 'Scene', 'Day', 'Camera', 'Project'];

export interface LutRuleEntry {
  id: number;
  scope: LutScope;
  /** "Default", a camera letter, a day number, a scene, "14/B", a clip. */
  target: string;
  lut: string;
  lutId: number;
  /** Today's clips this rule decides. */
  clips: number;
}

export interface DailiesSettings {
  include: 'circle' | 'all' | 'scene';
  scenes: string[];
  codec: string;
  resolution: string;
  audio: string;
  look: 'Per assignment rules' | 'Project default only' | 'None · LOG original';
  grouping: 'Scene → Setup → Take' | 'Camera roll' | 'Shoot order';
  /** A destination's id (a volume or a folder), or "" for none chosen. */
  destination: string;
  burnIns: Record<string, boolean>;
}

/** One rendered daily (spec §4.8). */
export interface DailyRender {
  takeId: string;
  label: string;
  clip: string;
  output: string;
  state: 'done' | 'failed';
  error: string | null;
  lut: string | null;
  codec: string;
  bytes: number | null;
  warnings: string[];
}

/** The day's script supervisor log, as last imported. */
export interface LogSummary {
  file: string;
  format: string;
  /** HH:MM, local. */
  importedAt: string;
  entries: number;
  vfxFlags: number;
  matched: number;
  review: number;
  unmatched: number;
  warnings: string[];
}

export interface ProjectState {
  /** The production's database file. */
  file: string;
  production: Production;
  /** The day open now. */
  day: ShootDay;
  days: ShootDay[];
  /** The day's scene list, each with the setups and takes the log gave it. */
  scenes: (SceneEntry & { setups: SetupEntry[] })[];
  log: LogSummary | null;
  /** Log entries waiting on (or decided by) the DIT. */
  matches: MatchEntry[];
  vfx: VfxEntry[];
  /** What the VFX mirroring is doing now ("Copying A015C002 to RAID…"), or null. */
  vfxActivity: string | null;
  /** Every camera clip of the day and its sync. */
  sync: SyncEntry[];
  /** What sync is doing now ("Reading timecode…"), or null. */
  syncActivity: string | null;
  luts: LutEntry[];
  lutRules: LutRuleEntry[];
  /** Camera clips of the day a look can be previewed on. */
  previewClips: { id: string; label: string }[];
  dailies: DailiesSettings;
  renders: DailyRender[];
  /** What dailies rendering is doing now, or null. */
  dailiesActivity: string | null;
  /** The FFmpeg this app renders with, or null when there is none. */
  ffmpeg: { version: string } | null;
  /** Productions opened before, newest first, for switching. */
  recent: { file: string; name: string }[];
}

export type ProjectResult = { ok: true; state: ProjectState } | { ok: false; reason: string };

export const DEFAULT_NAMING = ['{PROD}', '_', 'D{DAY}', '_', 'SC{SCENE}', '{SETUP}', '_', 'T{TAKE}', '_', '{CAM}{REEL}'];

/** Today in the computer's own time zone, as YYYY-MM-DD. */
export const localDate = (date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const DEFAULT_DAILIES: DailiesSettings = {
  include: 'circle',
  scenes: [],
  codec: 'ProRes 422 Proxy',
  resolution: '1920 × 1080 · full frame',
  audio: 'Synced · all tracks mixed',
  look: 'Per assignment rules',
  grouping: 'Scene → Setup → Take',
  destination: '',
  burnIns: { TC: true, 'Scene/Take': true, Look: true, Circle: true, Notes: false, 'Clip name': true, Watermark: false },
};

/** What dailies can be made as (src/main/dailies/render-args.ts). */
export const DAILIES_CODECS = ['ProRes 422 Proxy', 'ProRes 422 LT', 'DNxHR LB', 'H.264 · 10 Mb/s'];
export const DAILIES_RESOLUTIONS = ['1920 × 1080 · letterbox 2.39', '1920 × 1080 · full frame', '1280 × 720 · letterbox 2.39', '1280 × 720 · full frame'];
export const DAILIES_AUDIO = ['Synced · all tracks mixed', 'Synced · track 1 only', 'Camera scratch only', 'No audio'];
export const DAILIES_LOOKS: DailiesSettings['look'][] = ['Per assignment rules', 'Project default only', 'None · LOG original'];
export const DAILIES_GROUPING: DailiesSettings['grouping'][] = ['Scene → Setup → Take', 'Camera roll', 'Shoot order'];
