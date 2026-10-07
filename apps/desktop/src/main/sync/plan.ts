import type { MediaMeta } from '../media/metadata';

/**
 * Pairing picture with sound by timecode (spec §4.6, the primary method).
 *
 * Everything is compared in timecode frames: a clip's timecode is already a
 * frame count; a sound file's start (seconds since midnight, from its bext
 * time reference) becomes one at the clip's real rate, so 23.976 and 29.97
 * line up as they do on set. The result is the sound file's start relative to
 * the clip's first frame ("align"), in frames.
 */

export interface PictureClip {
  card: string;
  key: string;
  meta: MediaMeta | null;
  /** Why there is no metadata, if there is none. */
  metaError: string | null;
  mtimeMs: number;
  /** The sound file the script log names for this clip's take, if any. */
  hint: { card: string; key: string } | null;
}

export interface SoundFile {
  card: string;
  key: string;
  meta: MediaMeta | null;
  mtimeMs: number;
}

export interface TcPairing<T extends SoundFile = SoundFile> {
  sound: T;
  /** Sound file start minus clip start, in frames at the clip's rate. */
  alignFrames: number;
  confidence: number;
  why: string;
}

export const fpsOf = (meta: MediaMeta | null): number | null => (meta?.rate && meta.rate.den ? meta.rate.num / meta.rate.den : null);

/** The clip's start and end in timecode frames, or null without timecode or rate. */
export const clipSpan = (clip: Pick<PictureClip, 'meta'>): { start: number; end: number; fps: number } | null => {
  const fps = fpsOf(clip.meta);
  if (!clip.meta?.tc || !fps) return null;
  return { start: clip.meta.tc.frames, end: clip.meta.tc.frames + clip.meta.durationSec * fps, fps };
};

/** The sound file whose timecode covers the clip best; null when none overlaps it. */
export const pairByTimecode = <T extends SoundFile>(clip: PictureClip, sounds: T[]): TcPairing<T> | null => {
  const span = clipSpan(clip);
  if (!span) return null;
  const length = Math.max(1, span.end - span.start);
  const scored = sounds
    .filter((sound) => sound.meta?.soundStartSec !== null && sound.meta?.soundStartSec !== undefined)
    .map((sound) => {
      const start = sound.meta!.soundStartSec! * span.fps;
      const end = start + sound.meta!.durationSec * span.fps;
      const overlap = Math.min(end, span.end) - Math.max(start, span.start);
      return { sound, start, coverage: overlap / length };
    })
    .filter((item) => item.coverage > 0)
    .sort((a, b) => b.coverage - a.coverage || Number(isHint(clip, b.sound)) - Number(isHint(clip, a.sound)));
  const best = scored[0];
  if (!best) return null;
  const full = best.coverage > 0.999;
  // Two recorders (or a split file) both covering the clip: take the one the log names, else ask.
  const rival = scored.find((item) => item !== best && item.coverage > 0.999);
  const agreed = !rival || isHint(clip, best.sound);
  const confidence = full ? (agreed ? 99 : 85) : best.coverage >= 0.5 ? 80 : 50;
  const why = full
    ? agreed
      ? 'Timecode: the sound file covers the whole clip'
      : `Timecode: ${best.sound.key} and ${rival!.sound.key} both cover this clip`
    : `Timecode: the sound file covers ${Math.round(best.coverage * 100)}% of the clip`;
  return { sound: best.sound, alignFrames: best.start - span.start, confidence, why };
};

const isHint = (clip: PictureClip, sound: SoundFile) => clip.hint?.card === sound.card && clip.hint.key === sound.key;

/** Sound files worth trying by waveform for a clip with no timecode match: the log's, then the closest in time. */
export const waveformCandidates = <T extends SoundFile>(clip: PictureClip, sounds: T[], limit = 3): T[] => {
  const usable = sounds.filter((sound) => sound.meta?.hasAudio);
  const hinted = usable.filter((sound) => isHint(clip, sound));
  const span = clipSpan(clip);
  const when = (sound: SoundFile) => {
    // Prefer timecode distance; fall back to file times (both are when recording stopped).
    if (span && sound.meta?.soundStartSec != null) return Math.abs(sound.meta.soundStartSec * span.fps - span.start) / span.fps;
    return Math.abs(sound.mtimeMs - clip.mtimeMs) / 1000;
  };
  const near = usable
    .filter((sound) => !hinted.includes(sound))
    .map((sound) => ({ sound, gap: when(sound) }))
    .filter((item) => item.gap < 20 * 60)
    .sort((a, b) => a.gap - b.gap)
    .map((item) => item.sound);
  return [...hinted, ...near].slice(0, limit);
};
