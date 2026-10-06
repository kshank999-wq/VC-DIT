import { join } from 'node:path';
import type { IngestRequest } from '../../shared/media';

/**
 * Where an ingest writes, and the checks that keep it from writing where it
 * must not. Kept free of Electron and the disk so they can be tested alone.
 */

/** Paths compared the way the platform does: case-insensitive on Windows and (by default) macOS. */
const normalise = (path: string, platform: NodeJS.Platform) => {
  let value = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  if (platform === 'win32' || platform === 'darwin') value = value.toLowerCase();
  return value;
};

/** `child` is `parent` or somewhere inside it. */
export const sameOrInside = (child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean => {
  const c = normalise(child, platform);
  const p = normalise(parent, platform);
  return c === p || c.startsWith(p === '/' ? '/' : `${p}/`);
};

/**
 * Why `destination` may not receive copies of these cards, or null when it may.
 * Never onto a card (spec §4.2), never into a card's own folder tree, and never
 * a folder that contains a card (a copy of /Volumes would copy into itself).
 */
export const destinationProblem = (destination: string, cards: string[], platform: NodeJS.Platform = process.platform): string | null => {
  for (const card of cards) {
    if (sameOrInside(destination, card, platform)) return 'It is on a camera or sound card, and cards are never written to.';
    if (sameOrInside(card, destination, platform)) return 'It contains a card: a copy would land inside its own source.';
  }
  return null;
};

/** A safe single folder name: no separators or characters Windows refuses, no trailing dots or spaces. */
export const segment = (text: string, fallback = 'UNTITLED'): string => {
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/[. ]+$/g, '')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || fallback;
};

export const dayFolder = (day: IngestRequest['day']): string => `SHOOT_DAY_${String(day.number).padStart(3, '0')}_${segment(day.date, 'UNDATED')}`;

/** The spec's folder model (§5): PRODUCTION/SHOOT_DAY_###_DATE/{CAMERA,SOUND}_ORIGINALS/CARD. */
export const cardFolder = (root: string, request: Pick<IngestRequest, 'production' | 'day'>, sound: boolean, card: string): string =>
  join(root, segment(request.production.name || request.production.code), dayFolder(request.day), sound ? 'SOUND_ORIGINALS' : 'CAMERA_ORIGINALS', segment(card));

/** PRODUCTION/SHOOT_DAY_###_DATE/REPORTS/ingest_verification. */
export const reportsFolder = (root: string, request: Pick<IngestRequest, 'production' | 'day'>): string =>
  join(root, segment(request.production.name || request.production.code), dayFolder(request.day), 'REPORTS', 'ingest_verification');

/** Free space a destination should keep after a transfer: 1%, at least 1 GB. */
export const headroom = (totalBytes: number): number => Math.max(1e9, totalBytes * 0.01);
