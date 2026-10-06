import type { ChecksumMethod, VolumeRole } from '../../shared/media';
import type { Production, SceneStatus, ShootDay } from '../../shared/project';

/**
 * The records the UI works with, after the spec's data model (§6). In the
 * desktop app the media engine fills the volumes, destinations and transfers
 * (state/engine.ts); the rest still comes from the HALCYON demo day
 * (demo.ts) until its engine work lands.
 */

export type { ChecksumMethod, Production, SceneStatus, ShootDay, VolumeRole };

/** The six steps of the pipeline, in order. */
export type StepId = 'intake' | 'verify' | 'organize' | 'vfx' | 'sync' | 'output';

export type ScreenId =
  | 'today'
  | 'setup'
  | 'intake'
  | 'verify'
  | 'scenes'
  | 'match'
  | 'vfx'
  | 'sync'
  | 'looks'
  | 'dailies'
  | 'delivery'
  | 'reports';

/** Every status is shown as a dot and a word, never colour alone. */
export type Status = 'done' | 'working' | 'needs' | 'problem' | 'idle';


export interface Take {
  /** Unique within the day: `${scene}|${setup}|${take}`. */
  id: string;
  take: string;
  clipA: string;
  clipB: string | null;
  sound: string;
  tc: string;
  duration: string;
  circle: boolean;
  vfx: boolean;
  match: 'Matched' | 'Review' | 'Unmatched';
  sync: 'TC' | 'WF' | 'none';
}

export interface Setup {
  id: string;
  lens: string;
  takes: Take[];
}

export interface Scene {
  id: string;
  description: string;
  status: SceneStatus;
  notes: string;
  look: string;
  setups: Setup[];
}

/** A mounted volume (spec "Media Source"). */
export interface Volume {
  id: string;
  name: string;
  media: string;
  filesystem: string;
  used: string;
  fillPct: number;
  detected: string;
  role: VolumeRole;
  /** Included in the next ingest (sources only). */
  included: boolean;
  /** Already ingested today. */
  ingested: boolean;
  /** Where it is mounted (from the media engine). */
  mountPath?: string;
}

export interface IngestDestination {
  id: string;
  name: string;
  kind: string;
  free: string;
  fillPct: number;
  selected: boolean;
}

/** One destination of one card's transfer (spec "Transfer Record"). */
export interface TransferLeg {
  name: string;
  copyPct: number;
  verifyPct: number;
  failed: boolean;
  /** Simulated speed, % per tick. */
  rate: number;
  /** From the media engine: the destination's id, why it failed, and the card's folder there. */
  id?: string;
  error?: string | null;
  targetDir?: string;
}

export interface TransferJob {
  id: string;
  label: string;
  size: string;
  files: string;
  queued: boolean;
  checksum: ChecksumMethod;
  legs: TransferLeg[];
  /** From the media engine, while copying. */
  bytesPerSecond?: number;
  etaSeconds?: number | null;
}

export interface MatchCandidate {
  clip: string;
  tc: string;
  confidence: number;
  why: string;
}

/** A script-log entry that could not be matched with confidence (spec §4.5). */
export interface MatchItem {
  id: string;
  log: string;
  reason: string;
  fields: [string, string][];
  candidates: MatchCandidate[];
  picked: number;
  resolution: null | { kind: 'matched'; clip: string } | { kind: 'wild' };
}

export type SyncMethod = 'Timecode' | 'Waveform' | 'Manual';

export interface SyncItem {
  take: string;
  clip: string;
  sound: string;
  method: SyncMethod;
  offsetFrames: number;
  confidence: number;
  accepted: boolean;
}

export interface Lut {
  name: string;
  description: string;
}

export interface LutRule {
  scope: 'Project' | 'Camera' | 'Scene' | 'Clip';
  target: string;
  lut: string;
  clips: number;
}

export type MirrorMethod = 'Hard link' | 'Reference' | 'Physical copy';

export interface VfxShot {
  scene: string;
  setup: string;
  take: string;
  clip: string;
  note: string;
  flaggedBy: 'Script sup.' | 'DIT tag';
  prep: 'eligible' | 'blocked' | 'sent';
}

export interface DailiesOptions {
  include: 'circle' | 'all' | 'scene';
  codec: string;
  resolution: string;
  audio: string;
  look: string;
  grouping: string;
  destination: string;
  burnIns: Record<string, boolean>;
  built: boolean;
}

export interface DeliveryPackage {
  id: string;
  name: string;
  description: string;
  gb: number;
  selected: boolean;
}

export interface DeliveryDestination {
  id: string;
  name: string;
  kind: string;
  /** GB free; Infinity for cloud destinations without a quota. */
  freeGb: number;
  selected: boolean;
}

export interface ManifestRow {
  pkg: string;
  destination: string;
  files: string;
  size: string;
  completed: string;
  verification: string;
  retried: boolean;
}

export interface ReportRow {
  step: StepId;
  name: string;
  covers: string;
  time: string;
  status: 'Complete' | 'Needs you' | 'Problem';
  screen: ScreenId;
}

export interface ScriptLogImport {
  file: string;
  importedAt: string;
  entries: number;
  vfxFlags: number;
}
