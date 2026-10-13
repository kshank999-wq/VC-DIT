import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import type { ChecksumMethod } from '../../shared/media';
import { createHasher, prepareChecksums } from './checksum';
import { isIgnored } from './transfer';

/**
 * Relinking: a drive that comes back at a new place (a different drive
 * letter, "RAID 1" on a Mac, a NAS share mounted elsewhere) or a production
 * folder someone moved. The production still knows every copy by the folder
 * it was written to; this finds each card's folder again under the place
 * the DIT points at, and proves it is the same media before anything is
 * changed:
 *
 * - every file that verified there is present at the size it was copied at;
 * - the smallest file with a checksum on record reads back to that checksum.
 *
 * It first looks where the folder would be if only the drive moved, then
 * searches (a few levels down) for a folder with the card's name.
 */

export interface RelinkLeg {
  day: number;
  transferId: string;
  legId: string;
  card: string;
  name: string;
  root: string;
  targetDir: string;
  reportsDir: string;
  /** The files that verified on this copy. */
  files: { path: string; size: number; hash: string | null; method: ChecksumMethod }[];
}

export interface RelinkFound {
  leg: RelinkLeg;
  root: string;
  targetDir: string;
  reportsDir: string;
}

const split = (path: string) => path.split('/');
const portable = (path: string) => path.split(sep).join('/');

const hashOf = (path: string, method: ChecksumMethod): Promise<string> =>
  new Promise((resolve, reject) => {
    const hasher = createHasher(method);
    createReadStream(path)
      .on('data', (chunk) => hasher.update(chunk as Buffer))
      .on('error', reject)
      .on('end', () => resolve(hasher.digest()));
  });

/** Is this folder that copy: every file there at its size, and one read back to its checksum? */
export const sameCopy = async (dir: string, leg: RelinkLeg): Promise<boolean> => {
  if (leg.files.length === 0) return false;
  for (const file of leg.files) {
    const size = await stat(join(dir, ...split(file.path))).then((info) => (info.isFile() ? info.size : -1), () => -1);
    if (size !== file.size) return false;
  }
  const sample = leg.files.filter((file) => file.hash).sort((a, b) => a.size - b.size)[0];
  if (!sample) return true;
  await prepareChecksums();
  return (await hashOf(join(dir, ...split(sample.path)), sample.method).catch(() => '')) === sample.hash;
};

/** Folders under a place, by name (upper case), a few levels down: where a card's folder might now be. */
const foldersByName = async (root: string, depth: number, signal?: AbortSignal): Promise<Map<string, string[]>> => {
  const found = new Map<string, string[]>();
  const walk = async (dir: string, level: number): Promise<void> => {
    if (level > depth || signal?.aborted) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || isIgnored(entry.name)) continue;
      const path = join(dir, entry.name);
      const key = entry.name.toUpperCase();
      found.set(key, [...(found.get(key) ?? []), path]);
      await walk(path, level + 1);
    }
  };
  await walk(root, 0);
  return found;
};

/**
 * Where each copy is now, under `place`: found (and proved), or not. A copy
 * whose folder is still where it was is left out; there is nothing to do.
 */
export async function findMoved(legs: RelinkLeg[], place: string, options: { depth?: number; signal?: AbortSignal } = {}): Promise<{ found: RelinkFound[]; missing: RelinkLeg[] }> {
  const found: RelinkFound[] = [];
  const missing: RelinkLeg[] = [];
  let index: Map<string, string[]> | null = null;
  for (const leg of legs) {
    if (options.signal?.aborted) throw new Error('Stopped.');
    const below = portable(relative(leg.root, leg.targetDir));
    const reports = portable(relative(leg.root, leg.reportsDir));
    // Only the drive moved: the same folders under the new place.
    const moved = join(place, ...split(below));
    if (await sameCopy(moved, leg)) {
      found.push({ leg, root: place, targetDir: moved, reportsDir: join(place, ...split(reports)) });
      continue;
    }
    // Moved within it too: look for a folder with the card's name.
    index ??= await foldersByName(place, options.depth ?? 6, options.signal);
    let hit: RelinkFound | null = null;
    for (const dir of index.get(basename(leg.targetDir).toUpperCase()) ?? []) {
      if (!(await sameCopy(dir, leg))) continue;
      // The drive's new root, when the folders above the card's kept their shape; else the place pointed at.
      const tail = portable(dir).endsWith(`/${below}`) ? dir.slice(0, dir.length - below.length - 1) : place;
      hit = { leg, root: tail, targetDir: dir, reportsDir: join(tail, ...split(reports)) };
      break;
    }
    if (hit) found.push(hit);
    else missing.push(leg);
  }
  return { found, missing };
}
