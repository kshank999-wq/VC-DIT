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
}

export interface MediaState {
  volumes: MediaVolume[];
  folders: FolderDestination[];
  jobs: JobSnapshot[];
}

export interface IngestRequest {
  /** Volume ids (mount paths) of the cards to ingest. */
  sources: string[];
  /** Volume ids or folder destination ids. */
  destinations: string[];
  checksum: ChecksumMethod;
  production: { name: string; code: string };
  day: { number: number; date: string };
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
}

export interface JobSnapshot {
  id: string;
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
  startedAt: string | null;
  finishedAt: string | null;
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
