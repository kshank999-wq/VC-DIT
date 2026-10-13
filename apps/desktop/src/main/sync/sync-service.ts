import type { ProductionDb, SyncMedia, SyncRecord } from '../db/production-db';
import type { MetaResult } from '../media/metadata';
import type { AnalyseResult, AnalyseTask } from './analyse';
import type { AnalysisJob } from './analysis-worker';
import { clipSpan, fpsOf, pairByTimecode, waveformCandidates, type PictureClip } from './plan';

/**
 * Keeps the day's sync up to date (spec §4.6): reads the timecode of every
 * new media file, pairs each camera clip with its sound by timecode (checked
 * against the waveform where there is scratch audio), and on request tries
 * the waveform for clips timecode could not place.
 *
 * What the DIT has accepted or nudged is never redone. A timecode sync that
 * covers the whole clip, with nothing disagreeing, is accepted on its own;
 * everything else waits for a look.
 */

export type RunAnalysis = (jobs: AnalysisJob[]) => Promise<unknown[]>;

export interface SyncServiceDeps {
  db: () => ProductionDb;
  runAnalysis: RunAnalysis;
  changed: () => void;
}

const OFFLINE = 'No copy of this file can be read right now.';

export class SyncService {
  activity: string | null = null;
  private running: Promise<void> | null = null;
  private again: { waveform: boolean } | null = null;

  constructor(private readonly deps: SyncServiceDeps) {}

  run(options: { waveform: boolean } = { waveform: false }): Promise<void> {
    if (this.running) {
      this.again = { waveform: options.waveform || Boolean(this.again?.waveform) };
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

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private say(activity: string) {
    this.activity = activity;
    this.deps.changed();
  }

  private async work({ waveform }: { waveform: boolean }) {
    const db = this.deps.db();
    const day = db.currentDay().number;

    // 1. Read the headers of files not read yet. A file no copy of which can be reached is tried again later.
    const pending = db.pendingMeta(day);
    if (pending.length) {
      this.say(`Reading timecode from ${pending.length} file${pending.length === 1 ? '' : 's'}…`);
      const results = (await this.deps.runAnalysis(pending.map((item) => ({ kind: 'meta', paths: item.paths })))) as MetaResult[];
      if (this.deps.db() !== db) return;
      pending.forEach((item, index) => {
        const result = results[index];
        if (result && !(!result.ok && result.error === OFFLINE)) db.saveMeta(day, item.card, item.path, result);
      });
      // Clip timecode can now place logged takes that have no clip name.
      db.rematch(day);
    }

    // 2. Decide what each clip needs.
    const { pictures, sounds } = db.syncMedia(day);
    const records = new Map(db.syncRecords(day).map((record) => [`${record.card}|${record.clipKey}`, record]));
    const fallbackFps = Number.parseFloat(db.production().frameRate) || 24;
    const tasks: { picture: SyncMedia; fps: number; task: AnalyseTask }[] = [];
    for (const picture of pictures) {
      const id = `${picture.card}|${picture.key}`;
      const prior = records.get(id);
      if (prior && (prior.decided === 'dit' || prior.accepted)) continue;
      const clip: PictureClip = picture;
      const fps = fpsOf(picture.meta) ?? fallbackFps;
      const tc = pairByTimecode(clip, sounds);
      if (tc) {
        const unchanged =
          prior?.method === 'Timecode' && prior.soundKey === tc.sound.key && prior.soundCard === tc.sound.card && Math.abs((prior.alignFrames ?? NaN) - tc.alignFrames) < 0.5;
        if (unchanged) continue;
      } else if (prior?.method === 'Waveform') {
        // A waveform answer stands until the DIT decides.
        continue;
      } else if (!waveform) {
        // Nothing timecode can do; the waveform pass is the DIT's call.
        const reason = this.noneReason(picture, sounds.length);
        if (!prior || prior.method !== 'None' || prior.why !== reason) db.saveSync(day, this.none(picture, fps, reason));
        continue;
      }
      tasks.push({
        picture,
        fps,
        task: {
          clipPaths: picture.paths,
          fps,
          durationSec: picture.meta?.durationSec ?? 0,
          hasAudio: Boolean(picture.meta?.hasAudio),
          tc: tc ? { key: tc.sound.key, card: tc.sound.card, paths: tc.sound.paths, alignFrames: tc.alignFrames, confidence: tc.confidence, why: tc.why } : null,
          candidates: tc ? [] : waveformCandidates(clip, sounds).map((sound) => ({ key: sound.key, card: sound.card, paths: sound.paths })),
          none: this.noneReason(picture, sounds.length),
        },
      });
    }

    // 3. The reading and comparing, in the worker.
    if (tasks.length === 0) return;
    this.say(`Syncing ${tasks.length} clip${tasks.length === 1 ? '' : 's'}${waveform ? ' (waveform)' : ''}…`);
    const results = (await this.deps.runAnalysis(tasks.map(({ task }) => ({ kind: 'analyse', task })))) as AnalyseResult[];
    if (this.deps.db() !== db) return;
    tasks.forEach(({ picture, fps }, index) => {
      const result = results[index];
      if (!result) return;
      db.saveSync(day, {
        card: picture.card,
        clipKey: picture.key,
        soundCard: result.soundCard,
        soundKey: result.soundKey,
        method: result.method,
        alignFrames: result.alignFrames,
        baseFrames: result.baseFrames ?? result.alignFrames,
        fps,
        confidence: result.confidence,
        why: result.why,
        // Only a whole-clip timecode match nothing disagrees with is accepted without a look.
        accepted: result.method === 'Timecode' && result.confidence >= 99,
        decided: 'auto',
        barsPicture: result.barsPicture,
        barsSound: result.barsSound,
      });
    });
  }

  private none(picture: SyncMedia, fps: number, why: string): SyncRecord {
    return {
      card: picture.card,
      clipKey: picture.key,
      soundCard: null,
      soundKey: null,
      method: 'None',
      alignFrames: null,
      baseFrames: null,
      fps,
      confidence: 0,
      why,
      accepted: false,
      decided: 'auto',
      barsPicture: [],
      barsSound: [],
    };
  }

  private noneReason(picture: SyncMedia, soundCount: number): string {
    const waveformHint = picture.meta?.hasAudio ? ' Try the waveform pass.' : '';
    if (picture.metaError) return picture.metaError;
    if (!picture.meta) return 'Timecode not read yet.';
    if (!clipSpan(picture)) return `This clip has no timecode.${waveformHint}`;
    if (soundCount === 0) return 'No sound files ingested today yet.';
    return `No sound file's timecode overlaps this clip.${waveformHint}`;
  }
}
