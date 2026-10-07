import { access } from 'node:fs/promises';
import { readMediaAudio, readMediaMeta, type MetaResult } from '../media/metadata';
import { bars, findOffset } from './waveform';

/**
 * The heavy half of sync, run in a worker thread: reading audio and comparing
 * waveforms. Timecode pairs are double-checked against the scratch audio
 * when the clip has it (a recorder that was not jammed shows up here);
 * clips without a timecode pair are tried against candidate sound files.
 */

export interface AnalyseTask {
  /** Copies of the clip's media file, best first: the first that can be read is used. */
  clipPaths: string[];
  fps: number;
  durationSec: number;
  hasAudio: boolean;
  /** The timecode pairing, when there is one. */
  tc: { key: string; card: string; paths: string[]; alignFrames: number; confidence: number; why: string } | null;
  /** Sound files to try by waveform, when there is no timecode pairing. */
  candidates: { key: string; card: string; paths: string[] }[];
  /** Why nothing could be tried, when nothing could. */
  none: string;
}

export interface AnalyseResult {
  method: 'Timecode' | 'Waveform' | 'None';
  soundKey: string | null;
  soundCard: string | null;
  alignFrames: number | null;
  /** The timecode alignment, when there was one, for showing a waveform correction against it. */
  baseFrames: number | null;
  confidence: number;
  why: string;
  barsPicture: number[];
  barsSound: number[];
}

const firstReadable = async (paths: string[]): Promise<string | null> => {
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

/** Up to this much scratch audio is compared: plenty to place a take. */
const CLIP_SECONDS = 30;
/** Sound files are searched whole up to this length. */
const SOUND_SECONDS = 20 * 60;

export const analyse = async (task: AnalyseTask): Promise<AnalyseResult> => {
  const none = (why: string): AnalyseResult => ({ method: 'None', soundKey: null, soundCard: null, alignFrames: null, baseFrames: null, confidence: 0, why, barsPicture: [], barsSound: [] });
  const clipPath = await firstReadable(task.clipPaths);
  const clipAudio = clipPath && task.hasAudio ? await readMediaAudio(clipPath, { startSec: 0, seconds: CLIP_SECONDS }).catch(() => null) : null;
  const pictureBars = clipAudio ? bars(clipAudio.samples) : [];
  /** The stretch of a sound file that plays against the clip, for drawing. */
  const soundBars = async (path: string, alignFrames: number) => {
    const startSec = -alignFrames / task.fps;
    const seconds = Math.min(task.durationSec || CLIP_SECONDS, CLIP_SECONDS);
    const sound = await readMediaAudio(path, { startSec: Math.max(0, startSec), seconds: seconds - Math.max(0, -startSec) }).catch(() => null);
    if (!sound) return [];
    // Pad the part before the sound file starts, so the bars line up with the picture's.
    const lead = Math.max(0, -startSec) * sound.sampleRate;
    const padded = new Float32Array(Math.round(lead) + sound.samples.length);
    padded.set(sound.samples, Math.round(lead));
    return bars(padded);
  };

  if (task.tc) {
    const soundPath = await firstReadable(task.tc.paths);
    const result: AnalyseResult = {
      method: 'Timecode',
      soundKey: task.tc.key,
      soundCard: task.tc.card,
      alignFrames: task.tc.alignFrames,
      baseFrames: task.tc.alignFrames,
      confidence: task.tc.confidence,
      why: task.tc.why,
      barsPicture: pictureBars,
      barsSound: soundPath ? await soundBars(soundPath, task.tc.alignFrames) : [],
    };
    // Check timecode against the waveform, in a window two seconds either side.
    if (clipAudio && soundPath) {
      const windowStart = Math.max(0, -task.tc.alignFrames / task.fps - 2);
      const window = await readMediaAudio(soundPath, { startSec: windowStart, seconds: Math.min(task.durationSec, CLIP_SECONDS) + 4 }).catch(() => null);
      const match = window ? findOffset(clipAudio, window) : null;
      if (match && match.confidence >= 60) {
        const waveformAlign = -(windowStart + match.offsetSec) * task.fps;
        const apart = Math.round(waveformAlign - task.tc.alignFrames);
        if (Math.abs(apart) > 1) {
          return {
            ...result,
            confidence: Math.min(result.confidence, 70),
            why: `Timecode and waveform disagree by ${Math.abs(apart)} frames: check the recorder's timecode, or nudge to the waveform (${apart > 0 ? '+' : '−'}${Math.abs(apart)} fr)`,
          };
        }
        return { ...result, why: `${result.why}; the waveform agrees` };
      }
    }
    return result;
  }

  if (task.candidates.length === 0) return none(task.none);
  if (!clipAudio) return none(clipPath ? 'No timecode match, and no scratch audio in this clip to compare by waveform.' : 'No copy of this clip can be read right now.');
  let best: { candidate: AnalyseTask['candidates'][number]; path: string; offsetSec: number; confidence: number } | null = null;
  for (const candidate of task.candidates) {
    const path = await firstReadable(candidate.paths);
    if (!path) continue;
    const sound = await readMediaAudio(path, { startSec: 0, seconds: SOUND_SECONDS }).catch(() => null);
    const match = sound ? findOffset(clipAudio, sound) : null;
    if (match && (!best || match.confidence > best.confidence)) best = { candidate, path, offsetSec: match.offsetSec, confidence: match.confidence };
  }
  if (!best || best.confidence < 30) return none('No sound file resembles this clip\'s scratch audio. Sync it manually.');
  const alignFrames = -best.offsetSec * task.fps;
  return {
    method: 'Waveform',
    soundKey: best.candidate.key,
    soundCard: best.candidate.card,
    alignFrames,
    baseFrames: null,
    confidence: best.confidence,
    why: `Waveform: the scratch audio matches ${best.candidate.key} ${best.offsetSec.toFixed(2)} s in`,
    barsPicture: pictureBars,
    barsSound: await soundBars(best.path, alignFrames),
  };
};

/** Metadata of the first readable copy. */
export const readFirstMeta = async (paths: string[]): Promise<MetaResult> => {
  const path = await firstReadable(paths);
  return path ? readMediaMeta(path) : { ok: false, error: 'No copy of this file can be read right now.' };
};
