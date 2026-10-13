/**
 * Timecode recorded as sound: SMPTE linear timecode (LTC) on one of a
 * camera's audio channels, as a mirrorless camera, a DSLR or a drone gets it
 * from a sync box plugged into its microphone input. Read from the clip's
 * own audio when its file carries no timecode of its own.
 *
 * LTC is 80 bits a frame in biphase mark code: the signal flips at every
 * bit boundary, and a 1 flips once more in the middle. Each frame ends in
 * the sync word 0011 1111 1111 1101; the time is in BCD before it, least
 * significant bit first. A value is trusted only when several frames in a
 * row decode and count up one by one.
 */

export interface LtcTimecode {
  /** The clip's first frame, as a frame count at `base` (drop-frame counted as editors count it). */
  frames: number;
  base: number;
  dropFrame: boolean;
}

const SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
const RATES = [24, 25, 30, 23.976, 29.97];

/** A timecode label as a frame count: drop-frame skips two labels a minute (four at 59.94) except every tenth. */
export const labelFrames = (h: number, m: number, s: number, f: number, base: number, dropFrame: boolean): number => {
  const drop = dropFrame && base % 30 === 0 ? (base / 30) * 2 : 0;
  const minutes = h * 60 + m;
  return (minutes * 60 + s) * base + f - drop * (minutes - Math.floor(minutes / 10));
};

/** Where the signal flips, in samples, ignoring noise smaller than a tenth of its swing. */
const flips = (samples: Float32Array): number[] => {
  let sum = 0;
  for (const value of samples) sum += value;
  const mean = samples.length ? sum / samples.length : 0;
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value - mean));
  if (peak < 1e-3) return [];
  const threshold = peak * 0.1;
  const out: number[] = [];
  let high: boolean | null = null;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i]! - mean;
    if (value > threshold && high !== true) {
      if (high === false) out.push(i);
      high = true;
    } else if (value < -threshold && high !== false) {
      if (high === true) out.push(i);
      high = false;
    }
  }
  return out;
};

interface Frame {
  h: number;
  m: number;
  s: number;
  f: number;
  dropFrame: boolean;
  /** The sample where the frame's first bit starts. */
  at: number;
}

const bcd = (bits: number[], from: number, count: number) => bits.slice(from, from + count).reduce((sum, bit, i) => sum + (bit << i), 0);

/** Every LTC frame in the signal, read with a bit `period` of so many samples. */
const framesAt = (edges: number[], period: number): Frame[] => {
  const bits: number[] = [];
  const starts: number[] = [];
  const frames: Frame[] = [];
  const reset = () => {
    bits.length = 0;
    starts.length = 0;
  };
  for (let i = 0; i + 1 < edges.length; ) {
    const span = edges[i + 1]! - edges[i]!;
    if (span > period * 0.75 && span < period * 1.4) {
      bits.push(0);
      starts.push(edges[i]!);
      i += 1;
    } else if (span > period * 0.25 && span <= period * 0.75 && i + 2 < edges.length && edges[i + 2]! - edges[i + 1]! <= period * 0.75) {
      bits.push(1);
      starts.push(edges[i]!);
      i += 2;
    } else {
      reset();
      i += 1;
      continue;
    }
    if (bits.length < 80) continue;
    const tail = bits.length - 16;
    if (!SYNC.every((bit, k) => bits[tail + k] === bit)) continue;
    const word = bits.slice(bits.length - 80);
    const f = bcd(word, 0, 4) + 10 * bcd(word, 8, 2);
    const s = bcd(word, 16, 4) + 10 * bcd(word, 24, 3);
    const m = bcd(word, 32, 4) + 10 * bcd(word, 40, 3);
    const h = bcd(word, 48, 4) + 10 * bcd(word, 56, 2);
    if (f < 30 && s < 60 && m < 60 && h < 24) frames.push({ h, m, s, f, dropFrame: word[10] === 1, at: starts[starts.length - 80]! });
    reset();
  }
  return frames;
};

/**
 * The timecode of the clip's first frame, from LTC in these samples, or null
 * when there is none to be read. `fps` is the picture's rate, when known.
 */
export const decodeLtc = (samples: Float32Array, sampleRate: number, fps?: number | null): LtcTimecode | null => {
  const edges = flips(samples);
  if (edges.length < 200) return null;
  const rates = fps ? [fps, ...RATES.filter((rate) => Math.abs(rate - fps) > 0.01)] : RATES;
  for (const rate of rates) {
    const frames = framesAt(edges, sampleRate / (rate * 80));
    const base = Math.round(rate);
    // Three in a row counting up one frame at a time, at the same distance apart.
    for (let i = 0; i + 2 < frames.length; i += 1) {
      const run = frames.slice(i, i + 3);
      const counts = run.map((frame) => labelFrames(frame.h, frame.m, frame.s, frame.f, base, frame.dropFrame));
      if (counts[1] !== counts[0]! + 1 || counts[2] !== counts[1]! + 1) continue;
      const first = run[0]!;
      // Back to the clip's first frame: the LTC frame starts this many picture frames in.
      const offset = Math.round((first.at / sampleRate) * rate);
      return { frames: counts[0]! - offset, base, dropFrame: first.dropFrame };
    }
  }
  return null;
};
