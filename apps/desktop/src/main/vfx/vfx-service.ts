import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ProductionDb } from '../db/production-db';
import { dayFolder, segment } from '../media/rules';
import { mirrorShot, type RunCopy } from './mirror';

/**
 * Keeps the VFX folders in step with the day's VFX shots, and hands them to
 * VC VFX Prep.
 *
 * Hard links and references are instant and take no space, so they are made
 * as soon as a shot is flagged, matched and verified on a destination.
 * Physical copies can be large and share the drives with ingest, so they run
 * when the DIT asks ("Mirror now"). One run at a time; a request during a run
 * starts another when it ends.
 */

export interface VfxServiceDeps {
  db: () => ProductionDb;
  runCopy: RunCopy;
  tool: { name: string; version: string };
  /** Something changed that the screens show. */
  changed: () => void;
}

const stamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').replace('T', '_');
const csvCell = (value: string | number | null) => {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export class VfxService {
  activity: string | null = null;
  private running: Promise<void> | null = null;
  private again: { copies: boolean; retry: boolean } | null = null;

  constructor(private readonly deps: VfxServiceDeps) {}

  /** Make the mirrors still missing. `copies`: also physical copies; `retry`: also those that failed. */
  run(options: { copies: boolean; retry: boolean } = { copies: false, retry: false }): Promise<void> {
    if (this.running) {
      this.again = { copies: options.copies || Boolean(this.again?.copies), retry: options.retry || Boolean(this.again?.retry) };
      return this.running;
    }
    this.running = this.work(options).finally(() => {
      this.running = null;
      this.activity = null;
      this.deps.changed();
      const next = this.again;
      this.again = null;
      if (next) void this.run(next);
    });
    return this.running;
  }

  /** Waits for any run in progress (tests, quitting). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async work(options: { copies: boolean; retry: boolean }) {
    const db = this.deps.db();
    const day = db.currentDay().number;
    const plans = db.mirrorPlans(day, options.retry).filter((plan) => options.copies || plan.method !== 'Physical copy');
    for (const [index, plan] of plans.entries()) {
      this.activity = `${plan.method === 'Physical copy' ? 'Copying' : 'Mirroring'} ${plan.clip} on ${plan.location.name} (${index + 1} of ${plans.length})…`;
      this.deps.changed();
      const outcome = await mirrorShot(plan, this.deps.runCopy, this.deps.tool);
      // The production may have been switched mid-run only if no transfer ran; the plan's own database is the one to write.
      if (this.deps.db() !== db) return;
      db.saveMirror(day, plan.key, outcome);
    }
  }

  /**
   * Hand the day's ready shots to VC VFX Prep (spec §4.9, §9): a package on
   * every destination that holds their mirrors, in the shared metadata schema
   * (production, day, scene/setup/take, clip, notes, files and checksums), and
   * a CSV of the same for people. Returns how many shots went.
   */
  async sendToPrep(): Promise<number> {
    await this.running;
    const db = this.deps.db();
    const day = db.currentDay();
    const production = db.production();
    const shots = db.handoffShots(day.number);
    if (shots.length === 0) return 0;
    const now = new Date();
    const written: string[] = [];
    const sent = new Set<string>();
    const roots = [...new Set(shots.flatMap(({ locations }) => locations.map((location) => location.root)))];
    for (const root of roots) {
      try {
        await stat(root);
      } catch {
        continue;
      }
      const vfxDir = join(root, segment(production.name || production.code), dayFolder(day), 'VFX');
      const here = shots.flatMap(({ entry, locations }) => {
        const index = locations.findIndex((location) => location.root === root);
        const placed = entry.locations[index];
        return index >= 0 && placed?.state === 'mirrored' && placed.mirror ? [{ entry, location: locations[index]!, placed }] : [];
      });
      if (here.length === 0) continue;
      const body = {
        schema: 'vcdit.vfx-handoff/1',
        createdAt: now.toISOString(),
        tool: this.deps.tool,
        production: { name: production.name, code: production.code, frameRate: production.frameRate },
        day: { number: day.number, date: day.date },
        shots: here.map(({ entry, location, placed }) => ({
          scene: entry.scene,
          setup: entry.setup,
          take: entry.take,
          clip: entry.clip,
          note: entry.note,
          flaggedBy: entry.flaggedBy,
          mirror: { method: placed.method, folder: relative(vfxDir, placed.mirror!).replace(/\\/g, '/') },
          editorialFolder: relative(vfxDir, location.cardDir).replace(/\\/g, '/'),
          checksumMethod: location.checksum,
          files: location.files.map((file) => ({ path: file.path, size: file.size, checksum: file.hash })),
        })),
      };
      const base = join(vfxDir, `VC_VFX_PREP_${segment(production.code || production.name)}_D${String(day.number).padStart(3, '0')}_${stamp(now)}`);
      try {
        await mkdir(vfxDir, { recursive: true });
        await writeFile(`${base}.json`, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
        const rows = [
          ['scene', 'setup', 'take', 'clip', 'note', 'flagged_by', 'method', 'folder'],
          ...body.shots.map((shot) => [shot.scene, shot.setup, shot.take, shot.clip, shot.note, shot.flaggedBy, shot.mirror.method, shot.mirror.folder]),
        ];
        await writeFile(`${base}.csv`, `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`, 'utf8');
        written.push(`${base}.json`);
        for (const { entry } of here) sent.add(entry.key);
      } catch {
        // That drive could not take it; the others still do.
      }
    }
    if (written.length === 0) throw new Error('No destination could take the handoff package.');
    db.markSent(day.number, [...sent], written);
    this.deps.changed();
    return sent.size;
  }
}
