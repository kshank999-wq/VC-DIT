import { lstat, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { BrowseEntry, BrowseListing, BrowseSearch } from '../../shared/media';
import { sameOrInside } from './rules';
import { isIgnored } from './transfer';

/**
 * The Files panel's look at what is really on a drive: one folder at a
 * time, or a search of the production's folder. Read-only, and never
 * outside the folder it was given (a relative path that climbs out, or a
 * link that points out, is refused or not followed).
 */

const SYSTEM = new Set(['.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems', 'System Volume Information', '$RECYCLE.BIN', 'Thumbs.db', 'desktop.ini']);
const hidden = (name: string) => SYSTEM.has(name) || name.startsWith('.') || isIgnored(name);

/** The absolute path of `rel` under `root`, or null when it would leave it. */
export const inside = (root: string, rel: string): string | null => {
  const clean = rel.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  if (clean.some((part) => part === '..')) return null;
  const path = resolve(root, ...clean);
  return sameOrInside(path, resolve(root)) ? path : null;
};

const entry = async (dir: string, name: string, root: string): Promise<BrowseEntry | null> => {
  const path = join(dir, name);
  try {
    const link = await lstat(path);
    // A symbolic link is shown, never followed.
    if (link.isSymbolicLink()) return { name, rel: relative(root, path).split(sep).join('/'), path, kind: 'link', size: 0, modified: link.mtime.toISOString(), items: null, linked: true };
    if (link.isDirectory()) {
      const items = await readdir(path).then((names) => names.filter((child) => !hidden(child)).length, () => null);
      return { name, rel: relative(root, path).split(sep).join('/'), path, kind: 'folder', size: 0, modified: link.mtime.toISOString(), items, linked: false };
    }
    if (!link.isFile()) return null;
    // A hard link (a scene view, a VFX mirror) is the same data as the card folder's copy: more than one name.
    return { name, rel: relative(root, path).split(sep).join('/'), path, kind: 'file', size: link.size, modified: link.mtime.toISOString(), items: null, linked: link.nlink > 1 };
  } catch {
    return null;
  }
};

const order = (a: BrowseEntry, b: BrowseEntry) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name, undefined, { numeric: true });

/** One folder's contents: folders first, then files, by name as people sort them (A2 before A10). */
export const listFolder = async (root: string, rel: string, limit = 2000): Promise<BrowseListing> => {
  const dir = inside(root, rel);
  if (!dir) return { ok: false, reason: 'That folder is outside the production.' };
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return { ok: false, reason: 'That is not a folder.' };
  } catch {
    return { ok: false, reason: 'Not on this drive (yet).' };
  }
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => !hidden(name));
  const entries = (await Promise.all(names.slice(0, limit).map((name) => entry(dir, name, root)))).filter((item): item is BrowseEntry => item !== null).sort(order);
  return { ok: true, entries, more: Math.max(0, names.length - limit) };
};

/**
 * Names containing `query` anywhere under the production's folder, nearest
 * first. Stops after looking at `budget` entries so a huge drive cannot hold
 * the panel up; `complete` says whether everything was looked at.
 */
export const searchFolder = async (root: string, query: string, max = 200, budget = 50_000): Promise<BrowseSearch> => {
  const needle = query.trim().toLowerCase();
  if (!needle) return { ok: true, entries: [], complete: true };
  try {
    if (!(await stat(root)).isDirectory()) return { ok: false, reason: 'Not on this drive (yet).' };
  } catch {
    return { ok: false, reason: 'Not on this drive (yet).' };
  }
  const found: BrowseEntry[] = [];
  let seen = 0;
  let queue = [root];
  while (queue.length && found.length < max && seen < budget) {
    const next: string[] = [];
    for (const dir of queue) {
      const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (hidden(item.name)) continue;
        seen += 1;
        if (item.isDirectory()) next.push(join(dir, item.name));
        if (item.name.toLowerCase().includes(needle) && found.length < max) {
          const hit = await entry(dir, item.name, root);
          if (hit) found.push(hit);
        }
        if (seen >= budget) break;
      }
      if (seen >= budget || found.length >= max) break;
    }
    queue = next;
  }
  return { ok: true, entries: found, complete: queue.length === 0 && seen < budget && found.length < max };
};
