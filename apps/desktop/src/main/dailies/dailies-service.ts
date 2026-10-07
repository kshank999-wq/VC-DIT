import { access, copyFile, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DailiesSettings, DailyRender } from '../../shared/project';
import type { DailyPlan, ProductionDb } from '../db/production-db';
import { runFfmpeg, type Ffmpeg } from '../ffmpeg/ffmpeg';
import { createHasher, prepareChecksums } from '../media/checksum';
import { dayFolder, segment } from '../media/rules';
import { renderArgs, type RenderJob } from './render-args';

/**
 * Dailies (spec §4.8) and the look preview (spec §4.7), with FFmpeg.
 *
 * Each take is rendered into a private job folder's command (look, font and
 * burn-in text as files there), written beside its final name as
 * `.vcdit-part`, and named only when FFmpeg finished cleanly. A file already
 * there that VC DIT did not render is never replaced. Every daily is hashed
 * (xxHash64) for the manifest written to REPORTS/dailies, and the looks used
 * are copied to LUTS_LOOKS so editorial gets them with the media.
 */

export interface DailiesDeps {
  db: () => ProductionDb;
  ffmpeg: () => Promise<Ffmpeg | null>;
  /** The burn-in font file, or null when there is none. */
  font: string | null;
  /** A destination by id: a mounted destination volume or a destination folder. */
  destination: (id: string) => { name: string; root: string } | null;
  changed: () => void;
}

const firstReadable = async (paths: string[]) => {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Next copy.
    }
  }
  return null;
};

const hashFile = async (path: string): Promise<string> => {
  await prepareChecksums();
  const hasher = createHasher('xxHash64');
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hasher.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
  return hasher.digest();
};

const csvCell = (value: string | number | null) => {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const stamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').replace('T', '_');

export class DailiesService {
  activity: string | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly deps: DailiesDeps) {}

  busy(): boolean {
    return this.controller !== null;
  }

  stop(): void {
    this.controller?.abort();
  }

  /** Check what can be checked at once; then render in the background, saying how it goes. */
  async start(settings: DailiesSettings): Promise<{ takes: number }> {
    if (this.controller) throw new Error('Dailies are already rendering.');
    const ffmpeg = await this.deps.ffmpeg();
    if (!ffmpeg) throw new Error('FFmpeg is not available, so dailies cannot be rendered on this computer.');
    const destination = this.deps.destination(settings.destination);
    if (!destination) throw new Error('Pick where the dailies go: a destination drive or folder.');
    await stat(destination.root).catch(() => {
      throw new Error(`${destination.name} is not available.`);
    });
    const db = this.deps.db();
    const day = db.currentDay();
    const plans = db.dailiesPlan(day.number, settings);
    if (plans.length === 0) {
      throw new Error(
        settings.include === 'circle'
          ? 'No circle takes with a matched clip today. Import the log, or choose All takes.'
          : 'No takes with a matched clip for that choice.',
      );
    }
    db.saveDailiesSettings(settings);
    this.controller = new AbortController();
    void this.render(ffmpeg, db, day, plans, settings, destination.root, this.controller.signal).finally(() => {
      this.controller = null;
      this.activity = null;
      this.deps.changed();
    });
    return { takes: plans.length };
  }

  private say(text: string) {
    this.activity = text;
    this.deps.changed();
  }

  private async render(
    ffmpeg: Ffmpeg,
    db: ProductionDb,
    day: { number: number; date: string },
    plans: DailyPlan[],
    settings: DailiesSettings,
    root: string,
    signal: AbortSignal,
  ) {
    const production = db.production();
    const dayDir = join(root, segment(production.name || production.code), dayFolder(day));
    const ours = new Set(db.renders(day.number).map((render) => render.output));
    const done: (DailyRender & { checksum: string | null; sound: string })[] = [];
    const looks = new Map<string, { format: string; content: string }>();

    for (const [index, plan] of plans.entries()) {
      if (signal.aborted) break;
      const save = (render: Omit<DailyRender, 'takeId' | 'label' | 'clip' | 'codec'> & { checksum: string | null }) => {
        const full = { takeId: plan.takeId, label: plan.label, clip: plan.clip, codec: settings.codec, ...render };
        db.saveRender(day.number, plan, full);
        done.push({ ...full, sound: plan.sound?.key ?? '' });
      };
      const failed = (error: string, output = '') => save({ output, state: 'failed', error, lut: plan.lut?.name ?? null, bytes: null, checksum: null, warnings: [] });

      const clipPath = await firstReadable(plan.clipPaths);
      if (!plan.meta || plan.meta.kind !== 'picture' || !plan.meta.rate) {
        failed(plan.metaError ?? 'This clip has not been read yet, or FFmpeg cannot read its format.');
        continue;
      }
      if (!clipPath) {
        failed('No copy of this clip can be read right now.');
        continue;
      }
      const soundPath = plan.sound ? await firstReadable(plan.sound.paths) : null;
      const job: RenderJob = {
        label: plan.label,
        clip: plan.clip,
        clipPath,
        rate: plan.meta.rate,
        durationSec: plan.meta.durationSec,
        tc: plan.meta.tc ? { frames: plan.meta.tc.frames, base: plan.meta.tc.base } : null,
        clipHasAudio: plan.meta.hasAudio,
        sound: plan.sound && soundPath ? { path: soundPath, alignFrames: plan.sound.alignFrames, channels: plan.sound.channels } : null,
        look: plan.lut ? { name: plan.lut.name, extension: plan.lut.format } : null,
        circle: plan.circle,
        notes: plan.notes,
        production: production.name,
        choice: settings,
        font: Boolean(this.deps.font),
      };
      let command;
      try {
        command = renderArgs(job, ffmpeg);
      } catch (cause) {
        failed((cause as Error).message);
        continue;
      }
      const warnings = [...command.warnings];
      if (plan.sound && !plan.sound.accepted) warnings.push('Its sync has not been accepted yet.');

      const folder =
        settings.grouping === 'Camera roll'
          ? join(dayDir, 'SYNCED_DAILIES', segment(plan.card))
          : settings.grouping === 'Shoot order'
            ? join(dayDir, 'SYNCED_DAILIES')
            : join(dayDir, 'SYNCED_DAILIES', `SCENE_${segment(plan.scene).padStart(3, '0')}`, `SETUP_${plan.setup ? segment(plan.setup) : 'NONE'}`);
      const output = join(folder, `${segment(plan.label)}_${segment(plan.clip)}.${command.extension}`);
      if (!ours.has(output) && (await stat(output).catch(() => null))) {
        failed('A file with this name is already there, not made by VC DIT. It was not replaced.', output);
        continue;
      }

      const work = await mkdtemp(join(tmpdir(), 'vcdit-daily-'));
      try {
        if (plan.lut) {
          await writeFile(join(work, `look.${plan.lut.format}`), plan.lut.content, 'utf8');
          looks.set(plan.lut.name, plan.lut);
        }
        if (this.deps.font) await copyFile(this.deps.font, join(work, 'font.ttf'));
        for (const [name, content] of Object.entries(command.files)) await writeFile(join(work, name), content, 'utf8');
        await mkdir(folder, { recursive: true });
        const part = `${output}.vcdit-part`;
        const step = `${plan.label} · ${plan.clip} (${index + 1} of ${plans.length})`;
        this.say(`Rendering ${step}…`);
        let shown = 0;
        const result = await runFfmpeg(ffmpeg, [...command.args, part], {
          cwd: work,
          signal,
          onTime: (seconds) => {
            const pct = Math.min(99, Math.floor((seconds / Math.max(0.1, job.durationSec)) * 100));
            if (pct >= shown + 5) {
              shown = pct;
              this.say(`Rendering ${step} · ${pct}%`);
            }
          },
        });
        if (result.code !== 0 || result.stopped) {
          await rm(part, { force: true });
          failed(result.stopped ? 'Stopped.' : `FFmpeg could not render it: ${result.log.split('\n').pop() ?? 'unknown error'}`, output);
          continue;
        }
        await rename(part, output);
        const bytes = (await stat(output)).size;
        this.say(`Checking ${step}…`);
        save({ output, state: 'done', error: null, lut: plan.lut?.name ?? null, bytes, checksum: await hashFile(output), warnings });
      } catch (cause) {
        failed((cause as Error).message, output);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }

    // The looks travel with the dailies, and the day gets a manifest.
    try {
      for (const [name, lut] of looks) {
        const path = join(dayDir, 'LUTS_LOOKS', segment(name));
        if (await stat(path).catch(() => null)) continue;
        await mkdir(join(dayDir, 'LUTS_LOOKS'), { recursive: true });
        await writeFile(path, lut.content, 'utf8');
      }
      if (done.length) {
        const rows = [
          ['take', 'clip', 'file', 'state', 'codec', 'look', 'sound', 'bytes', 'xxh64', 'notes'],
          ...done.map((render) => [render.label, render.clip, render.output, render.state, render.codec, render.lut ?? '', render.sound, render.bytes, render.checksum, render.error ?? render.warnings.join(' ')]),
        ];
        await mkdir(join(dayDir, 'REPORTS', 'dailies'), { recursive: true });
        await writeFile(join(dayDir, 'REPORTS', 'dailies', `DAILIES_${stamp(new Date())}.csv`), `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`, 'utf8');
      }
    } catch {
      // The dailies themselves are made and recorded; the extras can be written again next time.
    }
  }

  /** One frame of a clip, as it is and through a look, for the Looks screen. */
  async preview(clipId: string, lutId: number | null): Promise<{ original: string; graded: string | null }> {
    const ffmpeg = await this.deps.ffmpeg();
    if (!ffmpeg) throw new Error('FFmpeg is not available, so looks cannot be previewed on this computer.');
    const db = this.deps.db();
    const clip = db.previewClips(db.currentDay().number).find((candidate) => candidate.id === clipId);
    if (!clip) throw new Error('That clip is not in today\'s media.');
    const path = await firstReadable(clip.paths);
    if (!path) throw new Error('No copy of this clip can be read right now.');
    const look = lutId === null ? null : db.lutFile(lutId);
    const at = Math.max(0, (clip.meta?.durationSec ?? 0) / 2);
    const work = await mkdtemp(join(tmpdir(), 'vcdit-look-'));
    try {
      const frame = async (name: string, filters: string[]) => {
        const result = await runFfmpeg(ffmpeg, ['-y', '-ss', at.toFixed(3), '-i', path, '-frames:v', '1', '-vf', [...filters, 'scale=960:-2'].join(','), '-q:v', '3', name], { cwd: work });
        if (result.code !== 0) throw new Error(`FFmpeg could not read a frame: ${result.log.split('\n').pop() ?? ''}`);
        return `data:image/jpeg;base64,${(await readFile(join(work, name))).toString('base64')}`;
      };
      const original = await frame('original.jpg', []);
      if (!look) return { original, graded: null };
      await writeFile(join(work, `look.${look.format}`), look.content, 'utf8');
      return { original, graded: await frame('graded.jpg', [`lut3d=file=look.${look.format}:interp=tetrahedral`]) };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
