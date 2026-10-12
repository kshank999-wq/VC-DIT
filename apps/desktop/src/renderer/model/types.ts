import type { ChecksumMethod, DeviceInfo, VolumeRole } from '../../shared/media';
import type { LutScope, MatchCandidate, MatchEntry, MirrorMethod, Production, SceneStatus, SetupEntry, ShootDay, TakeEntry, VfxLocation } from '../../shared/project';

export type Take = TakeEntry;
export type Setup = SetupEntry;
export type MatchItem = MatchEntry;

/**
 * The records the UI works with, after the spec's data model (§6). In the
 * desktop app the media engine fills the volumes, destinations and transfers
 * (state/engine.ts); the rest still comes from the HALCYON demo day
 * (demo.ts) until its engine work lands.
 */

export type { ChecksumMethod, MatchCandidate, Production, SceneStatus, ShootDay, VolumeRole };

/** The six steps of the pipeline, in order. */
export type StepId = 'intake' | 'verify' | 'organize' | 'vfx' | 'sync' | 'output';

export type ScreenId =
  | 'today'
  | 'setup'
  | 'intake'
  | 'verify'
  | 'scenes'
  | 'takes'
  | 'match'
  | 'vfx'
  | 'sync'
  | 'looks'
  | 'dailies'
  | 'delivery'
  | 'reports';

/** Every status is shown as a dot and a word, never colour alone. */
export type Status = 'done' | 'working' | 'needs' | 'problem' | 'idle';


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
  /** As a destination: fed from the backup rather than the card (an upload). */
  relay?: boolean;
  /** On the cart, not the network: from the backup it is a cascade copy. */
  local?: boolean;
  /** Its own speed limit for copies from the backup, bytes a second. */
  limit?: number | null;
  /** What the system says the device is: its model, bus, solid state, RAID. */
  device?: DeviceInfo;
}

export interface IngestDestination {
  id: string;
  name: string;
  kind: string;
  free: string;
  fillPct: number;
  selected: boolean;
  /** Fed from the backup rather than the card (an upload). */
  relay?: boolean;
  local?: boolean;
  limit?: number | null;
  /** Where it is (from the media engine), for the system's own icon. */
  path?: string;
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
  /** An upload fed from a backup (relayFrom, by name) rather than the card; why it is not moving; its own speed and file. */
  relay?: boolean;
  /** Fed from a backup to a drive on the cart: a cascade copy, not an upload. */
  local?: boolean;
  relayFrom?: string | null;
  waiting?: string | null;
  bytesPerSecond?: number;
  etaSeconds?: number | null;
  currentFile?: string | null;
}

export interface TransferJob {
  id: string;
  /** From the media engine: the card's name, camera or sound, and the file being copied now. */
  card?: string;
  sound?: boolean;
  currentFile?: string | null;
  label: string;
  size: string;
  files: string;
  queued: boolean;
  checksum: ChecksumMethod;
  legs: TransferLeg[];
  /** From the media engine, while copying. */
  bytesPerSecond?: number;
  etaSeconds?: number | null;
  /** The card's volume (its mount path), and when it was cleared for camera. */
  sourceId?: string;
  clearedAt?: string | null;
}

export type SyncMethod = 'Timecode' | 'Waveform' | 'Manual' | 'None';

export interface SyncItem {
  take: string;
  clip: string;
  sound: string;
  method: SyncMethod;
  offsetFrames: number;
  confidence: number;
  accepted: boolean;
  /** From the production database: the record's id, the clip's rate, why it stands as it does, and loudness to draw. */
  id?: string;
  fps?: number | null;
  why?: string;
  barsPicture?: number[];
  barsSound?: number[];
}

export interface Lut {
  name: string;
  description: string;
  /** From the production database. */
  id?: number;
  isDefault?: boolean;
}

export interface LutRule {
  scope: LutScope;
  target: string;
  lut: string;
  clips: number;
  /** From the production database. */
  id?: number;
  lutId?: number;
}

export type { MirrorMethod };

export interface VfxShot {
  scene: string;
  setup: string;
  take: string;
  clip: string;
  note: string;
  flaggedBy: 'Script sup.' | 'DIT tag';
  prep: 'eligible' | 'blocked' | 'sent';
  /** From the production database: the shot's key, and its editorial copies and mirrors on each destination. */
  key?: string;
  locations?: VfxLocation[];
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
  /** "By scene": which scenes. */
  scenes?: string[];
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
  /** From the desktop app's import: the format read and rows not fully understood. */
  format?: string;
  warnings?: string[];
}
