// Ported from VC Film Studio (lib/ltc-reader.ts @ 56e7a9c) so both read a sync box the same way. Keep the two in step.
// Changed from the original only by the non-null marks (!) that VC DIT's stricter indexing checks need.
/**
 * Turning a microphone into a timecode reader.
 *
 * `ltc.ts` decodes bits. This is the layer between it and the audio: finding
 * transitions in a stream of samples, and deciding — honestly — whether the
 * thing on the other end of the cable is actually being read right now.
 *
 * ---------------------------------------------------------------------------
 * THE DISPLAY MUST NEVER LIE ABOUT BEING LIVE
 *
 * This is the whole reason there is a state machine here rather than just a
 * variable holding the last timecode.
 *
 * A timecode display is believed. A supervisor glances at it, hits record on a
 * take, and the number goes in the log. If the cable is pulled at 10:14 and
 * the screen keeps showing 10:14:32:11 — frozen, but looking exactly like a
 * timecode — every take for the rest of the hour is logged against a number
 * that stopped being true, and nobody finds out until an editor cannot find
 * the shot.
 *
 * A frozen display is worse than a blank one. So the reader distinguishes:
 *
 *   LOCKED   frames are arriving and decoding. The number is live.
 *   LOST     they were, and stopped. Shows how long ago, never as live.
 *   NOISE    there is audio but no valid frames. Wrong cable, wrong input,
 *            or the phone's noise suppression is eating the signal.
 *   SILENT   there is no audio at all. Nothing is plugged in.
 *
 * NOISE and SILENT are separated deliberately, because they send somebody to
 * different places: silence is a cable, noise is a setting.
 *
 * Pure. getUserMedia lives in the component.
 */

import { decodeFrame, framesInStream, bitsFromIntervals, type LtcFrame } from './ltc';
import { frameToTimecode } from './ltc';

/* ------------------------------------------------------------- the signal --- */

/**
 * Where the waveform crosses zero, as gaps between crossings.
 *
 * LTC is a square wave and carries nothing in its amplitude, so crossings are
 * all that matter — which is why this survives a signal so hot it clips. That
 * tolerance is worth knowing about: a line-level output into a microphone
 * input is far too loud and clips hard, and it decodes perfectly anyway.
 *
 * `carry` threads across buffers. The audio arrives in 128-sample blocks and a
 * bit is wider than that at most rates, so a reader that forgot its position
 * between blocks would find almost no complete bits at all.
 *
 * ---------------------------------------------------------------------------
 * THE FIRST FRAME AFTER CONNECTING IS NEVER DECODED
 *
 * The first transition heard has no measurable interval before it — there is
 * nothing to measure from — so it establishes the sign reference and is
 * consumed. One bit is lost, which means the frame it belonged to is
 * incomplete and is discarded rather than half-read.
 *
 * This is correct and unavoidable for any LTC reader: you started listening
 * partway through a signal that was already running. It costs one frame — 40
 * milliseconds at 25fps — once, when the cable goes in. It is worth knowing
 * about only because it means a reader tested against a single isolated frame
 * decodes nothing and looks broken, while the same code against a continuous
 * feed locks immediately.
 */
export type CrossingState = {
  /** Sign of the last sample seen: 1, -1, or 0 before anything. */
  lastSign: number;
  /** Samples since the last crossing. */
  since: number;
  /** Loudest absolute sample in the last block, for telling quiet from dead. */
  peak: number;
};

export const freshCrossings = (): CrossingState => ({ lastSign: 0, since: 0, peak: 0 });

/**
 * A block of samples to transition gaps.
 *
 * A hysteresis band around zero, rather than a bare sign test: a real signal
 * has noise on it, and a bare test counts every wobble near the axis as a
 * crossing, which turns one bit into a dozen. The band is proportional to what
 * the block actually contains, so it adapts to a hot signal and a quiet one
 * without a level control the supervisor would have to set.
 */
export function crossings(
  samples: Float32Array | readonly number[], state: CrossingState,
): { intervals: number[]; state: CrossingState } {
  const intervals: number[] = [];
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
  }

  /* Below this, treat it as silence rather than hunting for edges in the noise
     floor of a disconnected input. A real LTC feed is nowhere near this quiet
     even through a resistive attenuator. */
  const SILENCE = 0.002;
  if (peak < SILENCE) {
    return {
      intervals,
      state: { lastSign: state.lastSign, since: state.since + samples.length, peak },
    };
  }

  const band = peak * 0.1;
  let { lastSign, since } = state;

  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i]!;
    since += 1;
    const sign = v > band ? 1 : v < -band ? -1 : 0;
    if (sign === 0) continue;                 // inside the band: undecided
    if (lastSign === 0) { lastSign = sign; since = 0; continue; }
    if (sign !== lastSign) {
      intervals.push(since);
      since = 0;
      lastSign = sign;
    }
  }

  return { intervals, state: { lastSign, since, peak } };
}

/* -------------------------------------------------------------- the state --- */

export type ReaderState = {
  /** The last frame that decoded, and when. Null until one does. */
  last: { frame: LtcFrame; atEpochMs: number } | null;
  /** Loudest sample recently seen. Distinguishes a dead cable from a bad one. */
  peak: number;
  /** Frames decoded since the reader started. */
  framesRead: number;
};

export const freshReader = (): ReaderState => ({ last: null, peak: 0, framesRead: 0 });

/**
 * Fold a block of audio into the reader.
 *
 * Returns new state rather than mutating, so a component can hold it in a ref
 * and a test can drive it a block at a time.
 */
export function readBlock(
  reader: ReaderState,
  intervals: readonly number[],
  spb: number,
  peak: number,
  nowEpochMs: number,
): ReaderState {
  const { frames } = framesInStream(bitsFromIntervals(intervals, spb));
  const newest = frames.length ? frames[frames.length - 1] : null;
  return {
    last: newest ? { frame: newest, atEpochMs: nowEpochMs } : reader.last,
    peak,
    framesRead: reader.framesRead + frames.length,
  };
}

/**
 * How many samples to gather before handing a block to the reader.
 *
 * THIS IS THE SETTING THAT DECIDES WHETHER ANY OF THIS WORKS, and it is not
 * about latency or CPU.
 *
 * A window of audio is partial at both ends — the first bit has nothing before
 * it to measure from, the last has no closing transition — so a block holding
 * exactly one frame yields ZERO usable frames, every time. Measured: 2048
 * samples at 48kHz is 42ms, about one frame at 24fps, and it locks on 0% of
 * blocks even when the frame rate is set correctly. At 4096 it locks on 100%.
 *
 * That failure is worth naming because of how it presents: a decoder that is
 * completely correct reads nothing at all, which on a shoot day looks exactly
 * like a bad cable.
 *
 * Three frames, so two survive the trimming and there is margin for jitter and
 * for a box running off speed. The latency this adds costs nothing, because
 * the display free-runs from the reading's timestamp rather than showing the
 * decoded number directly.
 */
export function blockSamplesFor(sampleRate: number, framesPerSecond: number): number {
  if (!(sampleRate > 0) || !(framesPerSecond > 0)) return 8192;
  return Math.ceil((sampleRate / framesPerSecond) * 3);
}

export type ReaderHealth =
  | { state: 'silent'; says: string }
  | { state: 'noise'; says: string }
  | { state: 'locked'; says: string; timecode: string; frame: LtcFrame }
  | { state: 'lost'; says: string; timecode: string; agoMs: number };

/**
 * How long a decode stays "live".
 *
 * Frames arrive at the picture rate, so at 24fps a gap of a quarter of a
 * second is six missed frames — well past a dropout and into something being
 * wrong. Short enough that a pulled cable shows within half a glance, long
 * enough that a single corrupt frame does not flicker the display.
 */
const LOCK_MS = 250;

/**
 * What the screen may claim, given what has actually been read.
 *
 * The timecode is only returned under `locked`. Under `lost` it comes back
 * too, but on a differently-named field with an age attached, so a caller
 * cannot accidentally render a dead number in the live slot — the type makes
 * the mistake awkward rather than relying on the caller to remember.
 */
export function readerHealth(reader: ReaderState, nowEpochMs: number): ReaderHealth {
  const SILENCE = 0.002;

  if (reader.last) {
    const ago = nowEpochMs - reader.last.atEpochMs;
    if (ago <= LOCK_MS) {
      return {
        state: 'locked',
        says: 'Reading timecode from the cable.',
        timecode: frameToTimecode(reader.last.frame),
        frame: reader.last.frame,
      };
    }
    return {
      state: 'lost',
      says: reader.peak < SILENCE
        ? 'The timecode stopped and the input has gone quiet — check the cable at both ends.'
        : 'There is still audio but no timecode in it. The box may have stopped, or the '
          + 'cable has moved to the wrong output.',
      timecode: frameToTimecode(reader.last.frame),
      agoMs: ago,
    };
  }

  if (reader.peak < SILENCE) {
    return {
      state: 'silent',
      says: 'Nothing is coming in. Check the cable, and that the tablet is listening to '
        + 'the adapter rather than its own microphone.',
    };
  }

  /* Audio, but nothing decodable. Overwhelmingly the phone's own processing:
     noise suppression and automatic gain are designed to remove exactly the
     kind of steady buzz LTC is, and they are ON by default. */
  return {
    state: 'noise',
    says: 'There is audio but no timecode in it. The commonest cause is the browser\'s '
      + 'noise suppression removing the signal — it must be switched off in the audio '
      + 'request. After that, check the cable is carrying LTC and not programme sound.',
  };
}

/** Whether a reading is fit to be written into a take log. */
export const isLive = (h: ReaderHealth): h is Extract<ReaderHealth, { state: 'locked' }> =>
  h.state === 'locked';

/**
 * The audio constraints this needs, and why each one.
 *
 * NOT COSMETIC. Every one of these is on by default and every one of them
 * destroys LTC: the browser's processing exists to make speech intelligible,
 * and a 2kHz square wave is precisely what it is built to treat as noise. A
 * reader that omits these gets silence and a supervisor who thinks the cable
 * is broken.
 */
export const LTC_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
} as const;

/**
 * A decoded frame as a jam point, so the free-running clock can carry on if
 * the cable is pulled.
 *
 * The two mechanisms are complementary rather than alternatives: the cable is
 * the truth while it is connected, and the jam is what keeps a usable number
 * on screen when it is not — clearly labelled as a free run, never as a read.
 */
export function jamFromReading(
  frame: LtcFrame, atEpochMs: number, rateKey: string,
): { timecode: string; atEpochMs: number; rateKey: string } {
  return { timecode: frameToTimecode(frame), atEpochMs, rateKey };
}

export { decodeFrame, frameToTimecode };

/**
 * What the transitions LOOK like — not just how many there are.
 *
 * ---------------------------------------------------------------------------
 * THE MISTAKE THIS EXISTS TO PREVENT
 *
 * Faced with a cable that would not decode, I measured 2537 transitions a
 * second, observed that LTC at 24fps runs between 1920 and 3840, and told the
 * user the signal was on the wire with only its edges damaged. It was not. The
 * transition count was a plausible number produced by something that was not a
 * square wave at all, and plotting the waveform showed it immediately.
 *
 * A rate alone cannot tell those apart, because noise of roughly the right
 * busyness produces roughly the right count. THE SHAPE CAN. Biphase mark has
 * exactly two legal gaps between transitions:
 *
 *   a 0 bit — one full bit period, no transition in the middle    -> spb
 *   a 1 bit — a transition at the midpoint, so two half gaps      -> spb/2
 *
 * So in real timecode nearly every interval sits in one of two tight clumps
 * and almost nothing sits between them. In noise they spread across the whole
 * range. `clustered` is the fraction that landed in a clump, and it is the
 * number that separates "timecode with damaged edges" from "not timecode".
 *
 * Reported, never acted on: this decides nothing, it only says what is there.
 * The decoder is still the only thing that decides whether a frame read.
 */
export type IntervalShape = {
  /** How many gaps were measured. Zero means there is nothing to describe. */
  n: number;
  /** Gaps close to a full bit — a 0 bit. */
  nearFull: number;
  /** Gaps close to half a bit — half of a 1 bit. */
  nearHalf: number;
  /** Everything else: too short, too long, or in the valley between. */
  stray: number;
  /** nearFull + nearHalf, over n. 1 is a clean square wave; 0 is noise. */
  clustered: number;
  /** Plain words, because the number needs a threshold to mean anything. */
  says: string;
};

/**
 * TOLERANCE, AND WHY IT IS NARROW.
 *
 * The first version allowed a quarter of a bit either side. That is the widest
 * the bands can be without overlapping, and it makes the measurement useless,
 * because the two bands then TOUCH: [spb/4, 3spb/4] and [3spb/4, 5spb/4] are
 * one continuous stretch. So clustered degenerated into "the gap is somewhere
 * between a quarter of a bit and a bit and a quarter", which random noise
 * passes about two thirds of the time. Measured, against noise built to have a
 * plausible transition count: 0.61 - all but indistinguishable from timecode.
 *
 * THE VALLEY IS THE WHOLE SIGNAL. Biphase mark puts gaps at spb/2 and at spb
 * and nowhere in between, so what identifies it is the EMPTY space around
 * three quarters of a bit. A tolerance that fills that space in cannot see the
 * thing it is looking for.
 *
 * An eighth of a bit either side leaves that middle quarter empty and counted
 * as stray. Real timecode sits far inside the bands: a decoder resolving
 * half-bits needs edges better than an eighth of a bit or it would not decode
 * at all, so anything this rejects was never going to read.
 */
export function intervalShape(
  intervals: readonly number[], samplesPerBit: number,
): IntervalShape {
  const n = intervals.length;
  if (n === 0 || !(samplesPerBit > 0)) {
    return {
      n: 0, nearFull: 0, nearHalf: 0, stray: 0, clustered: 0,
      says: 'No transitions to look at.',
    };
  }

  const tol = samplesPerBit / 8;
  const half = samplesPerBit / 2;
  let nearFull = 0, nearHalf = 0;
  for (const gap of intervals) {
    if (Math.abs(gap - samplesPerBit) < tol) nearFull += 1;
    else if (Math.abs(gap - half) < tol) nearHalf += 1;
  }
  const stray = n - nearFull - nearHalf;
  const clustered = (nearFull + nearHalf) / n;

  /* The thresholds are deliberately far apart, with an explicit middle. A
     borderline capture is a real outcome and reporting it as either extreme is
     how a wrong diagnosis gets made confidently. */
  const says = clustered >= 0.9
    ? 'The gaps between transitions fall into the two widths timecode uses. '
      + 'This is the right shape.'
    : clustered >= 0.6
      ? 'Some of the transitions are the right widths and many are not. Either '
        + 'the signal is being distorted on the way in, or something else is '
        + 'mixed in with it.'
      : 'The gaps between transitions are spread across every width. This is '
        + 'not a timecode square wave, whatever the transition count suggests '
        + '— a plausible count is not evidence, and has been wrong here before.';

  return { n, nearFull, nearHalf, stray, clustered, says };
}
