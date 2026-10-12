import type { Brand } from './brands';

/**
 * What the media engine (src/main/media) and the screens say to each other
 * over IPC. Plain data only: sizes in bytes, times as ISO strings.
 */

export type ChecksumMethod = 'xxHash64' | 'MD5' | 'SHA-1';

export type VolumeRole = 'Camera' | 'Sound' | 'Destination' | 'Shuttle' | 'Archive' | 'Other';

/** Roles that are read from and never written to (spec §4.2). */
export const SOURCE_ROLES: readonly VolumeRole[] = ['Camera', 'Sound'];
/** Roles that may receive copies. */
export const DESTINATION_ROLES: readonly VolumeRole[] = ['Destination', 'Shuttle', 'Archive'];

/** A mounted volume the engine found (spec "Media Source"). */
export interface MediaVolume {
  /** The mount path: stable while it stays mounted. */
  id: string;
  name: string;
  mountPath: string;
  /** "SD card", "USB drive", "Network share", "Drive". */
  kind: string;
  filesystem: string;
  totalBytes: number;
  freeBytes: number;
  /** What its folders look like: "ARRI · ARRIRAW", "Sound · 212 WAV", "Empty volume". */
  detected: string;
  /** The role the engine would give it from its contents. */
  suggestedRole: VolumeRole;
  /** The role in force: the operator's choice, remembered for this volume, else the suggestion. */
  role: VolumeRole;
  /** A transfer from it was queued this session. */
  ingested: boolean;
  /** As a destination: fed from the main backup once the card has verified there, not from the card (a slow cloud or network drive). */
  relay: boolean;
  /** On the cart, not the network: fed from the backup, it is a cascade copy rather than an upload. */
  local?: boolean;
  /** Its own speed limit for copies from the backup, bytes a second; null for none. */
  limit?: number | null;
  /** What the device itself is, from the system: its model, how it is connected, solid state or spinning. */
  device: DeviceInfo;
  /** A card: the saved workflow it matches, by id. */
  workflow?: string | null;
}

/** What the system says about the disk behind a volume. Any of it may be unknown. */
export interface DeviceInfo {
  /** The maker's model name: "RED MINI-MAG 960GB", "OWC ThunderBay 4", "Samsung PSSD T7". */
  model: string | null;
  /** "USB", "Thunderbolt", "PCI-Express", "SD", "NVMe", "SATA", "RAID", "Network". */
  bus: string | null;
  solidState: boolean | null;
  /** Part of a RAID set the system knows about (AppleRAID, a Windows RAID bus, Storage Spaces). */
  raid: boolean;
}

/** A folder picked as a destination: a NAS share, a LucidLink mount, a folder on the RAID. */
export interface FolderDestination {
  id: string;
  name: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
  /** The folder can be reached now. */
  online: boolean;
  /** Fed from the main backup rather than the card (see MediaVolume.relay). */
  relay: boolean;
  local?: boolean;
  limit?: number | null;
}

export interface MediaState {
  volumes: MediaVolume[];
  folders: FolderDestination[];
  jobs: JobSnapshot[];
  /** Uploads that relay from a backup are paused (they carry on when resumed, from the last verified file). */
  relaysPaused: boolean;
  /** Most bytes a second uploads may write, or null for no limit. */
  relayLimit: number | null;
  /** Saved workflows, on this computer. */
  workflows?: Workflow[];
  /** Why a card that would start on its own has not: "Waiting for SHUTTLE_02.". By card (volume id). */
  autoStart?: Record<string, string>;
}

/** Which cards a workflow is for: a camera maker, sound cards, or any camera card. */
export type WorkflowCamera = 'any' | 'sound' | Brand;

/**
 * A saved way to offload a kind of card (Silverstack's presets): where it
 * goes, how it is checked, whether it starts by itself, and what follows.
 * Kept on the computer, like drive roles; drives are remembered by name and
 * size, folders by their place.
 */
export interface Workflow {
  id: string;
  name: string;
  camera: WorkflowCamera;
  destinations: { key: string; name: string }[];
  checksum: ChecksumMethod;
  /** Start the copy as soon as a matching card and all its drives are in. */
  autoStart: boolean;
  /** Render the day's dailies (with the production's dailies settings) when the card has verified. */
  dailies: boolean;
  /** In the engine's state only: its destinations mounted now (ids), and the ones that are not (names). */
  here?: string[];
  missing?: string[];
}

export interface IngestRequest {
  /** Volume ids (mount paths) of the cards to ingest. */
  sources: string[];
  /** Volume ids or folder destination ids. */
  destinations: string[];
  checksum: ChecksumMethod;
  production: { name: string; code: string };
  day: { number: number; date: string };
  /** The workflow it follows, for what comes after the copy. */
  workflow?: string | null;
}

export type IngestResult = { ok: true; jobs: string[] } | { ok: false; reason: string };

/** One destination of one card's transfer (spec "Transfer Record"). */
export interface LegSnapshot {
  id: string;
  name: string;
  copyPct: number;
  verifyPct: number;
  /** Finished with at least one file not verified, or the destination stopped working. */
  failed: boolean;
  error: string | null;
  /** Files that did not verify on this destination. */
  problemFiles: number;
  /** Where the card's folder is on this destination. */
  targetDir: string;
  /** Fed from a backup rather than the card. */
  relay: boolean;
  /** A drive on the cart: fed from a backup, a cascade copy rather than an upload. */
  local?: boolean;
  /** The backup it is (or will be) read from, by name, once known. */
  relayFrom: string | null;
  /** Why a relay is not moving now: "Paused", "Waiting for RAID: plug it back in to carry on.". */
  waiting: string | null;
  /** A relay's own speed, time left and file, while it runs (a card's copy reports these on the job). */
  bytesPerSecond: number;
  etaSeconds: number | null;
  currentFile: string | null;
}

export interface JobSnapshot {
  id: string;
  /** The card's name: "A015". */
  card: string;
  /** Camera or sound. */
  sound: boolean;
  label: string;
  sourceId: string;
  totalBytes: number;
  fileCount: number;
  queued: boolean;
  running: boolean;
  checksum: ChecksumMethod;
  legs: LegSnapshot[];
  /** Source bytes per second while copying; 0 otherwise. */
  bytesPerSecond: number;
  /** Seconds left in the copy, when known. */
  etaSeconds: number | null;
  /** The file being copied now (relative to the card), while copying. */
  currentFile: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** When the card's ingested files were erased so it could go back to camera; null until then. */
  clearedAt: string | null;
  /** The workflow it followed, by name, and what came after the copy ("Dailies started", or why not). */
  workflow?: string | null;
  followUp?: string | null;
}

/** The check made before a card is cleared, and again just before anything is erased. */
export interface ClearCheck {
  ok: boolean;
  card: string;
  /** What is on the card now that was ingested. */
  files: number;
  bytes: number;
  /** Each copy the production's rule relies on, checked just now. */
  copies: { name: string; ok: boolean; problem: string | null; files: number }[];
  /** Why it cannot be cleared; empty when it can. */
  problems: string[];
  checkedAt: string;
}

/** A drive sealed before it leaves set: every file copied to it, checked against the drive. */
export interface SealOutcome {
  ok: boolean;
  name: string;
  root: string;
  /** Files the production copied to this drive, on every day. */
  files: number;
  bytes: number;
  /** Every file read back and its checksum compared; otherwise present at its copied size. */
  verified: boolean;
  missing: string[];
  changed: { path: string; why: string }[];
  /** On the drive in a card folder, but not in the production. Noted, not a reason to refuse. */
  added: string[];
  /** Files with no checksum recorded at ingest, checked by size only. */
  unhashed: number;
  /** Why it was not sealed; empty when it was. */
  problems: string[];
  checkedAt: string;
  /** The manifest written to the drive, when sealed. */
  manifest: string | null;
}

export type SealResult = { ok: true; outcome: SealOutcome } | { ok: false; reason: string; outcome?: SealOutcome };

export type ClearResult = { ok: true; removed: number; check: ClearCheck } | { ok: false; reason: string; check?: ClearCheck };

/** Something in a folder on a drive, as the Files panel shows it. */
export interface BrowseEntry {
  name: string;
  /** Under the production's folder, with `/`. */
  rel: string;
  /** Where it is on this computer. */
  path: string;
  kind: 'folder' | 'file' | 'link';
  size: number;
  modified: string;
  /** A folder's number of items, when it could be read. */
  items: number | null;
  /** Shares its data with another name (a hard-linked scene view or VFX mirror), or a link. */
  linked: boolean;
}

export type BrowseListing = { ok: true; entries: BrowseEntry[]; more: number } | { ok: false; reason: string };
export type BrowseSearch = { ok: true; entries: BrowseEntry[]; complete: boolean } | { ok: false; reason: string };

/** A drive or folder the Files panel can show, and whether the production's folder is on it. */
export interface BrowseRoot {
  id: string;
  name: string;
  /** The production's folder there. */
  path: string;
  present: boolean;
}

/** Human sizes, decimal as drive makers and Finder count them. */
export const formatBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
};
