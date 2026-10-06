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
}

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

export interface ProjectState {
  /** The production's database file. */
  file: string;
  production: Production;
  /** The day open now. */
  day: ShootDay;
  days: ShootDay[];
  scenes: SceneEntry[];
  /** Productions opened before, newest first, for switching. */
  recent: { file: string; name: string }[];
}

export type ProjectResult = { ok: true; state: ProjectState } | { ok: false; reason: string };

export const DEFAULT_NAMING = ['{PROD}', '_', 'D{DAY}', '_', 'SC{SCENE}', '{SETUP}', '_', 'T{TAKE}', '_', '{CAM}{REEL}'];

/** Today in the computer's own time zone, as YYYY-MM-DD. */
export const localDate = (date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
