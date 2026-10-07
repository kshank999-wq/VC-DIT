/**
 * Waveform sync (spec §4.6 fallback): find where a camera's scratch audio
 * sits inside a production sound file. The scratch mic and the boom hear the
 * same events at different levels and colours, so what is compared is the
 * shape of loudness over time (log energy, its slow drift removed), not the
 * samples themselves. A coarse search at 100 Hz over every position, then a
 * fine one at 1 kHz around the best: millisecond accuracy, well inside a frame.
 */

/** Log loudness at `outRate` values per second, with its slow drift removed and scaled to unit spread. */
export const envelope = (samples: Float32Array, sampleRate: number, outRate: number): Float32Array => {
  const window = Math.max(1, Math.round(sampleRate / outRate));
  const count = Math.floor(samples.length / window);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    for (let j = i * window, end = j + window; j < end; j += 1) sum += samples[j]! * samples[j]!;
    out[i] = Math.log10(1e-6 + Math.sqrt(sum / window));
  }
  // Remove the drift over half a second, so a louder or quieter mic still compares.
  const span = Math.max(1, Math.round(outRate / 2));
  const prefix = new Float64Array(count + 1);
  for (let i = 0; i < count; i += 1) prefix[i + 1] = prefix[i]! + out[i]!;
  const flat = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const from = Math.max(0, i - span);
    const to = Math.min(count, i + span + 1);
    flat[i] = out[i]! - (prefix[to]! - prefix[from]!) / (to - from);
  }
  let energy = 0;
  for (const value of flat) energy += value * value;
  const scale = energy > 0 ? Math.sqrt(count / energy) : 0;
  for (let i = 0; i < count; i += 1) flat[i] = flat[i]! * scale;
  return flat;
};

/**
 * Normalised correlation of `clip` against `sound` at each lag in [from, to]
 * (clip[i] against sound[i + lag]); only where they overlap by at least
 * `minOverlap` values.
 */
const correlate = (clip: Float32Array, sound: Float32Array, from: number, to: number, minOverlap: number): { lag: number; score: number }[] => {
  const squares = new Float64Array(sound.length + 1);
  for (let i = 0; i < sound.length; i += 1) squares[i + 1] = squares[i]! + sound[i]! * sound[i]!;
  const clipSquares = new Float64Array(clip.length + 1);
  for (let i = 0; i < clip.length; i += 1) clipSquares[i + 1] = clipSquares[i]! + clip[i]! * clip[i]!;
  const out: { lag: number; score: number }[] = [];
  for (let lag = from; lag <= to; lag += 1) {
    const start = Math.max(0, -lag);
    const end = Math.min(clip.length, sound.length - lag);
    if (end - start < minOverlap) continue;
    let dot = 0;
    for (let i = start; i < end; i += 1) dot += clip[i]! * sound[i + lag]!;
    const norm = Math.sqrt((clipSquares[end]! - clipSquares[start]!) * (squares[end + lag]! - squares[start + lag]!));
    out.push({ lag, score: norm > 0 ? dot / norm : 0 });
  }
  return out;
};

export interface WaveformMatch {
  /** Where the clip's audio starts inside the sound file, in seconds (negative: before the file starts). */
  offsetSec: number;
  /** 0–89: waveform sync always asks for a look (spec §8). */
  confidence: number;
  /** The best correlation, and how far it stands above the next best elsewhere. */
  peak: number;
  margin: number;
}

/** Where `clip` (scratch audio) lies in `sound`, or null when they do not resemble each other. */
export const findOffset = (clip: { samples: Float32Array; sampleRate: number }, sound: { samples: Float32Array; sampleRate: number }): WaveformMatch | null => {
  const coarseRate = 100;
  const a = envelope(clip.samples, clip.sampleRate, coarseRate);
  const b = envelope(sound.samples, sound.sampleRate, coarseRate);
  if (a.length < coarseRate || b.length < coarseRate) return null;
  // At least half the clip (or two seconds) must overlap the sound.
  const minOverlap = Math.max(coarseRate * 2, Math.floor(a.length / 2));
  const scores = correlate(a, b, -Math.floor(a.length / 2), b.length - Math.floor(a.length / 2), Math.min(minOverlap, a.length));
  if (scores.length === 0) return null;
  const best = scores.reduce((top, item) => (item.score > top.score ? item : top));
  // The next best peak away from this one (more than 0.3 s off).
  const second = scores.filter((item) => Math.abs(item.lag - best.lag) > 0.3 * coarseRate).reduce((top, item) => Math.max(top, item.score), -1);

  // Refine at 1 kHz within ±30 ms of the coarse answer.
  const fineRate = 1000;
  const fa = envelope(clip.samples, clip.sampleRate, fineRate);
  const fb = envelope(sound.samples, sound.sampleRate, fineRate);
  const centre = best.lag * (fineRate / coarseRate);
  const fine = correlate(fa, fb, centre - 30, centre + 30, Math.min(fa.length, Math.max(fineRate * 2, Math.floor(fa.length / 2))));
  const sharp = fine.length ? fine.reduce((top, item) => (item.score > top.score ? item : top)) : { lag: centre, score: best.score };

  const margin = best.score - Math.max(0, second);
  const confidence = Math.round(Math.min(1, Math.max(0, (best.score - 0.2) / 0.6)) * 60 + Math.min(1, Math.max(0, margin / 0.3)) * 29);
  if (best.score < 0.25 || margin < 0.05) return { offsetSec: sharp.lag / fineRate, confidence: Math.min(confidence, 40), peak: best.score, margin };
  return { offsetSec: sharp.lag / fineRate, confidence, peak: best.score, margin };
};

/** Loudness as `count` bars from 0 to 100, for drawing. */
export const bars = (samples: Float32Array, count = 160): number[] => {
  if (samples.length === 0) return [];
  const per = samples.length / count;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    let peak = 0;
    for (let j = Math.floor(i * per), end = Math.min(samples.length, Math.floor((i + 1) * per)); j < end; j += 1) peak = Math.max(peak, Math.abs(samples[j]!));
    out.push(peak);
  }
  const top = Math.max(...out) || 1;
  return out.map((value) => Math.round((value / top) * 100));
};
