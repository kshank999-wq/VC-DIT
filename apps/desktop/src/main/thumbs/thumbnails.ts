import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProductionDb } from '../db/production-db';
import { runFfmpeg, type Ffmpeg } from '../ffmpeg/ffmpeg';

/**
 * Clip thumbnails for the Scene Organizer: one frame from the middle of the
 * clip, as shot or through its look (the clip's assignment rule), read from
 * a verified copy, never the card. Each is made once with FFmpeg and kept in
 * the app's own data, named by what it shows (the file, its size and time,
 * the look and the size asked for), so a changed file or look makes a new one.
 * At most two FFmpeg runs at a time, so a pool of fifty clips does not swamp
 * the drives an ingest may be using.
 */

export interface ThumbnailDeps {
  db: () => ProductionDb;
  ffmpeg: () => Promise<Ffmpeg | null>;
  /** Where thumbnails are kept. */
  dir: string;
}

export type ThumbnailSize = 'small' | 'large';
const WIDTH: Record<ThumbnailSize, number> = { small: 320, large: 960 };
const RUNNING_AT_ONCE = 2;

const readable = async (paths: string[]) => {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // The next copy.
    }
  }
  return null;
};

export class Thumbnails {
  private readonly making = new Map<string, Promise<string>>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly deps: ThumbnailDeps) {}

  /** A clip's frame as a JPEG data URL. `clip` is the clip's name ("A015C002"), optionally with its card ("A015|A015C002"). */
  async get(clip: string, options: { look: boolean; size: ThumbnailSize }): Promise<string> {
    const ffmpeg = await this.deps.ffmpeg();
    if (!ffmpeg) throw new Error('FFmpeg is not available, so there are no thumbnails on this computer.');
    const db = this.deps.db();
    const clips = db.previewClips(db.currentDay().number);
    const found = clips.find((candidate) => candidate.id === clip) ?? clips.find((candidate) => candidate.id.endsWith(`|${clip}`));
    if (!found) throw new Error('This clip has no readable picture yet.');
    const path = await readable(found.paths);
    if (!path) throw new Error('No copy of this clip can be read right now.');
    const look = options.look && found.lutId !== null ? db.lutFile(found.lutId) : null;
    const info = await stat(path);
    const key = createHash('sha1')
      .update([path, info.size, info.mtimeMs, look ? createHash('sha1').update(look.content).digest('hex') : '', options.size, 'v1'].join('|'))
      .digest('hex');
    const file = join(this.deps.dir, `${key}.jpg`);
    let making = this.making.get(key);
    if (!making) {
      making = this.make(ffmpeg, file, path, Math.max(0, (found.meta?.durationSec ?? 0) / 2), look, WIDTH[options.size]).finally(() => this.making.delete(key));
      this.making.set(key, making);
    }
    return `data:image/jpeg;base64,${(await readFile(await making)).toString('base64')}`;
  }

  private async make(ffmpeg: Ffmpeg, file: string, path: string, at: number, look: { format: string; content: string } | null, width: number): Promise<string> {
    try {
      await access(file);
      return file;
    } catch {
      // Not made yet.
    }
    if (this.running >= RUNNING_AT_ONCE) await new Promise<void>((resume) => this.waiting.push(resume));
    this.running += 1;
    const work = await mkdtemp(join(tmpdir(), 'vcdit-thumb-'));
    try {
      if (look) await writeFile(join(work, `look.${look.format}`), look.content, 'utf8');
      const filters = [...(look ? [`lut3d=file=look.${look.format}:interp=tetrahedral`] : []), `scale=${width}:-2`];
      const result = await runFfmpeg(ffmpeg, ['-y', '-ss', at.toFixed(3), '-i', path, '-frames:v', '1', '-vf', filters.join(','), '-q:v', '4', 'frame.jpg'], { cwd: work });
      if (result.code !== 0) throw new Error(`FFmpeg could not read a frame: ${result.log.trim().split('\n').pop() ?? ''}`);
      await mkdir(this.deps.dir, { recursive: true });
      // Named only when whole, so a half-written thumbnail is never shown.
      await writeFile(`${file}.part`, await readFile(join(work, 'frame.jpg')));
      await rename(`${file}.part`, file);
      return file;
    } finally {
      await rm(work, { recursive: true, force: true });
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }
}
