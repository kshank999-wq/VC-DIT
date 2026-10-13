import { lstat, mkdir, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { linkFiles } from '../vfx/mirror';

/**
 * The scene view (spec §4.4, §5): each clip of the day also appears under
 * CAMERA_ORIGINALS/_BY_SCENE/SCENE_###/SETUP_X/<take name>, and circle takes
 * under SELECTS_CIRCLE_TAKES, without a second copy. The card folders stay
 * exactly as ingested; these folders hold hard links to the same data, or,
 * on a drive that cannot hold links (exFAT, FAT32, some network shares), a
 * reference file naming where the clip is.
 *
 * Because the view follows the log, a clip can move (a match is corrected,
 * the naming template changes). Its old folder is then taken down, and only
 * what this made is ever removed: a hard link to the card copy (the same
 * data, which stays in the card folder) or its own reference files. Anything
 * else found there is left where it is.
 */

export const REFERENCE_FILES = ['VIEW_REFERENCE.json', 'VIEW_REFERENCE.txt'];

export interface ViewClip {
  clip: string;
  card: string;
  scene: string;
  setup: string;
  take: string;
  files: { path: string; size: number; hash: string | null }[];
}

export type ViewMethod = 'Hard link' | 'Reference';

const writeReference = async (cardDir: string, target: string, clip: ViewClip, why: string) => {
  const folder = relative(target, cardDir).replace(/\\/g, '/');
  await mkdir(target, { recursive: true });
  const body = {
    schema: 'vcdit.view-reference/1',
    clip: clip.clip,
    card: clip.card,
    scene: clip.scene,
    setup: clip.setup,
    take: clip.take,
    cardFolder: folder,
    why,
    files: clip.files.map((file) => ({ path: file.path, size: file.size, checksum: file.hash })),
  };
  await writeFile(join(target, REFERENCE_FILES[0]!), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await writeFile(
    join(target, REFERENCE_FILES[1]!),
    [
      `${clip.clip}${clip.take ? ` — Scene ${clip.scene}, Setup ${clip.setup || '—'}, Take ${clip.take}` : ''}`,
      '',
      why,
      'The media is in the card folder:',
      `  ${folder}`,
      '',
      ...clip.files.map((file) => `  ${file.path}  ${file.size} bytes`),
      '',
    ].join('\n'),
    'utf8',
  );
};

/** Place one clip in a view folder: hard links where the drive can, else a reference. */
export const buildView = async (cardDir: string, target: string, clip: ViewClip): Promise<ViewMethod> => {
  await stat(cardDir);
  if ((await linkFiles(cardDir, clip.files, target, 'scene folder')) === 'linked') return 'Hard link';
  await writeReference(cardDir, target, clip, 'This drive cannot hold hard links (exFAT, FAT32 or a network share), so the clip is referenced here instead.');
  return 'Reference';
};

/**
 * Take down a view folder this made: its links to the card copy and its own
 * reference files, then any folders left empty, up to (not including) `stop`.
 */
export const removeView = async (target: string, cardDir: string, stop: string): Promise<void> => {
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        await rmdir(path).catch(() => undefined);
        continue;
      }
      if (dir === target && REFERENCE_FILES.includes(entry.name)) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      try {
        const here = await lstat(path);
        const original = await stat(join(cardDir, relative(target, path)));
        // The same data as the card copy: only a link this made. Unlinking it leaves the card copy whole.
        if (here.isFile() && here.dev === original.dev && here.ino === original.ino && here.nlink > 1) await unlink(path);
      } catch {
        // Not ours to remove.
      }
    }
  };
  await walk(target);
  // The take's folder, then its setup and scene folders while they are empty.
  for (let dir = target; dir.startsWith(stop + sep) && dir !== stop; dir = dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      break;
    }
  }
};
