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
  /** Productions opened before, newest first, for switching. */
  recent: { file: string; name: string }[];
}

export type ProjectResult = { ok: true; state: ProjectState } | { ok: false; reason: string };

export const DEFAULT_NAMING = ['{PROD}', '_', 'D{DAY}', '_', 'SC{SCENE}', '{SETUP}', '_', 'T{TAKE}', '_', '{CAM}{REEL}'];

/** Today in the computer's own time zone, as YYYY-MM-DD. */
export const localDate = (date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
