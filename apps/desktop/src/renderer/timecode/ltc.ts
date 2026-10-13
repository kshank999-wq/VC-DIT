// Ported from VC Film Studio (lib/ltc.ts @ 56e7a9c) so both read a sync box the same way. Keep the two in step.
// Changed from the original only by the non-null marks (!) that VC DIT's stricter indexing checks need.
/**
 * Linear timecode, decoded from audio.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS AND NOT WI-FI
 *
 * Every sync box a unit owns puts LTC out of a 3.5mm jack: Tentacle, Ambient
 * Lockit, Deity TC-1, UltraSync ONE, the sound cart, the back of most cameras.
 * A cable from that into the tablet's mic input is timecode the browser can
 * actually read, with getUserMedia and nothing else.
 *
 * It is the only continuous option that does not cost something else:
 *
 *   Wi-Fi sync means joining the BOX's access point, which takes the tablet off
 *   the unit network — so the app that wants the timecode loses its connection
 *   to get it. Jamming over Wi-Fi and switching back leaves a free run that
 *   drifts, which is the thing being avoided.
 *
 *   Bluetooth LE is Chrome-only, needs a user gesture per device, and none of
 *   these boxes publish a GATT profile a web page could read anyway.
 *
 *   LTC over audio needs a cable and nothing else. It works on iOS Safari and
 *   Android Chrome, the tablet stays on the network, and because it reads the
 *   real signal every frame there is no drift to correct.
 *
 * ---------------------------------------------------------------------------
 * THE FORMAT (SMPTE 12M)
 *
 * Eighty bits per frame, so at 24fps the signal is 1920 bits a second and
 * sounds like a fax machine. Biphase mark encoded: there is a transition at
 * every bit boundary, and a ONE has an extra transition in the middle. So a
 * zero is one long interval between transitions and a one is two short ones.
 * That is what makes it survive being recorded, played back at the wrong
 * level, and run through a cheap mic input — it carries its own clock, and
 * polarity does not matter, which is why a mis-wired cable still decodes.
 *
 * The payload is binary-coded decimal, LEAST SIGNIFICANT BIT FIRST, with user
 * bits interleaved between the digits, and a fixed sync word at the end that
 * is the only way to know where a frame starts.
 *
 * ---------------------------------------------------------------------------
 * A WRONG TIMECODE IS WORSE THAN NO TIMECODE
 *
 * Everything here refuses rather than guesses. A frame that does not carry the
 * sync word is discarded; BCD digits out of range are discarded; a frame whose
 * fields exceed the rate is discarded. The caller gets null and shows the
 * supervisor that nothing is being read, which sends somebody to check the
 * cable. A plausible-looking number that is one hour out sends an editor into
 * the wrong reel and is not discovered until the cut does not sync.
 *
 * Pure. The microphone lives in the component.
 */

import { type RateKey, rateFor } from './timecode';

/**
 * The sync word, bits 64-79, in transmission order.
 *
 * Chosen by the standard so it cannot occur in the payload: twelve consecutive
 * ones are impossible elsewhere because the user-bit fields are four bits wide
 * and separated by BCD digits that cap out below fifteen. It is also
 * asymmetric, which is how a reader tells forward playback from reverse.
 */
const SYNC_WORD = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1] as const;

export const LTC_FRAME_BITS = 80;

/** What one decoded frame carries. */
export type LtcFrame = {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  /** Bit 10. The signal says whether it is drop frame; we do not assume. */
  dropFrame: boolean;
  /** Bit 11. */
  colourFrame: boolean;
  /** The 32 user bits, as eight hex digits. Cameras put reel and date here. */
  userBits: string;
};

/* ---------------------------------------------------------------- payload --- */

/**
 * Read a BCD field, least significant bit first.
 *
 * LSB first is not a detail to skim: reading these the other way round yields
 * a timecode that is correct whenever the digit is symmetric — 0, 3, 9 — and
 * wrong the rest of the time, which is the worst possible failure because it
 * looks right often enough to be believed.
 */
function bcd(bits: readonly number[], start: number, count: number): number {
  let v = 0;
  for (let i = 0; i < count; i += 1) v |= (bits[start + i]! & 1) << i;
  return v;
}

/**
 * Eighty bits to a frame, or null.
 *
 * The bit layout is fixed by the standard and reads as a jumble because the
 * user bits are interleaved between the digits of the timecode. Field
 * positions are written out rather than computed, since the irregularity IS
 * the specification and a clever loop would only hide it.
 */
export function decodeFrame(bits: readonly number[]): LtcFrame | null {
  if (bits.length !== LTC_FRAME_BITS) return null;

  for (let i = 0; i < SYNC_WORD.length; i += 1) {
    if (bits[64 + i] !== SYNC_WORD[i]) return null;
  }

  const frames = bcd(bits, 0, 4) + bcd(bits, 8, 2) * 10;
  const seconds = bcd(bits, 16, 4) + bcd(bits, 24, 3) * 10;
  const minutes = bcd(bits, 32, 4) + bcd(bits, 40, 3) * 10;
  const hours = bcd(bits, 48, 4) + bcd(bits, 56, 2) * 10;

  /* Range-checked here rather than by the caller. A BCD nibble holds 0-15, so
     a corrupted digit reads as a number the standard cannot mean — 09:61:00:00
     is not a late minute, it is a bad read, and passing it on as timecode
     would put it in a log. */
  if (hours > 23 || minutes > 59 || seconds > 59 || frames > 59) return null;
  if (bcd(bits, 0, 4) > 9 || bcd(bits, 16, 4) > 9
    || bcd(bits, 32, 4) > 9 || bcd(bits, 48, 4) > 9) return null;

  /* User bits, most significant group last, as the eight hex digits every
     camera and every sync box displays them. */
  let userBits = '';
  for (const start of [4, 12, 20, 28, 36, 44, 52, 60]) {
    userBits = bcd(bits, start, 4).toString(16) + userBits;
  }

  return {
    hours,
    minutes,
    seconds,
    frames,
    dropFrame: bits[10] === 1,
    colourFrame: bits[11] === 1,
    userBits: userBits.toUpperCase(),
  };
}

/**
 * A decoded frame as timecode.
 *
 * The separator comes from the SIGNAL's drop-frame bit, not from the project
 * setting: the box is the authority on what it is sending, and a mismatch
 * between the two is something the supervisor needs to see rather than have
 * quietly normalised away.
 */
export function frameToTimecode(f: LtcFrame): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(f.hours)}:${p(f.minutes)}:${p(f.seconds)}${f.dropFrame ? ';' : ':'}${p(f.frames)}`;
}

/**
 * Does the signal agree with what the project is set to?
 *
 * A box sending non-drop into a project set to 29.97 DF produces a log that is
 * off by about two seconds an hour — small enough to survive a spot check and
 * large enough to matter by the end of a reel. Reported, never corrected.
 */
export function rateDisagreement(f: LtcFrame, projectRate: RateKey): string | null {
  const rate = rateFor(projectRate);
  if (f.dropFrame !== rate.dropFrame) {
    return `The box is sending ${f.dropFrame ? 'drop frame' : 'non-drop'} timecode `
      + `and this production is set to ${rate.label}. One of the two is wrong.`;
  }
  if (f.frames >= rate.nominal) {
    return `The box is sending frame numbers up to ${f.frames}, which cannot happen `
      + `at ${rate.label}. The production's frame rate is probably not what the box `
      + 'is running.';
  }
  return null;
}

/* ------------------------------------------------------------- the signal --- */

/**
 * Biphase mark, from the gaps between transitions.
 *
 * Input is the number of samples between successive edges in the audio — the
 * component finds those with a zero crossing detector, which is all this needs
 * because LTC is a square wave and amplitude carries nothing.
 *
 * A zero occupies one whole bit period; a one is split in half. So a long gap
 * is a zero, and a PAIR of short gaps is a one. A short gap with no partner is
 * corruption, not a bit — it is dropped along with the frame it lands in.
 *
 * `samplesPerBit` is computed by the caller from the sample rate and the frame
 * rate, which makes the threshold a known quantity rather than something
 * inferred from a signal that might be silence. It adapts within tolerance so
 * a box running slightly off speed, or audio resampled by the browser, still
 * reads.
 */
export function bitsFromIntervals(
  intervals: readonly number[], samplesPerBit: number,
): number[] {
  const bits: number[] = [];
  if (!(samplesPerBit > 0)) return bits;

  /* Three quarters of a bit. Comfortably above a half-bit gap and below a full
     one, so both classifications survive a signal running ±25% off nominal —
     wider than any real box drifts, and wide enough for the resampling a phone
     does between the microphone and the Web Audio graph. */
  let expected = samplesPerBit;
  const threshold = () => expected * 0.75;

  for (let i = 0; i < intervals.length; i += 1) {
    const gap = intervals[i]!;

    if (gap >= threshold()) {
      bits.push(0);
      // Track the real bit period from the zeros, which are full-bit by
      // definition. Slow enough not to chase a single corrupt gap.
      expected = expected * 0.9 + gap * 0.1;
      continue;
    }

    /* A half gap. Its partner must be the next one, and must also be short —
       otherwise this is noise and the pair is abandoned rather than guessed
       into a bit. */
    const partner = intervals[i + 1];
    if (partner === undefined || partner >= threshold()) continue;

    bits.push(1);
    expected = expected * 0.9 + (gap + partner) * 0.1;
    i += 1;
  }

  return bits;
}

/**
 * Every complete frame in a bit stream.
 *
 * Frames are found by their sync word rather than by counting from the start,
 * because a stream from a microphone begins mid-frame and can lose bits when
 * the cable is nudged. Anchoring on the sync word means a glitch costs one
 * frame instead of everything after it.
 *
 * Returns them in order, with the index just past the last complete frame so a
 * caller reading continuously knows what to keep.
 */
export function framesInStream(
  bits: readonly number[],
): { frames: LtcFrame[]; consumedTo: number } {
  const frames: LtcFrame[] = [];
  let consumedTo = 0;

  /* Scan for the sync word, then take the 64 bits BEFORE it. The sync word
     terminates its frame rather than starting one — a reader that treats it as
     a header is a frame out, which is a whole frame of error on every read. */
  for (let i = 0; i + SYNC_WORD.length <= bits.length; i += 1) {
    let matched = true;
    for (let j = 0; j < SYNC_WORD.length; j += 1) {
      if (bits[i + j] !== SYNC_WORD[j]) { matched = false; break; }
    }
    if (!matched) continue;

    const start = i - 64;
    if (start >= 0) {
      const frame = decodeFrame(bits.slice(start, start + LTC_FRAME_BITS));
      if (frame) frames.push(frame);
    }
    consumedTo = i + SYNC_WORD.length;
    i = consumedTo - 1;
  }

  return { frames, consumedTo };
}

/* ------------------------------------------------------------- generating --- */

/**
 * A frame back to eighty bits.
 *
 * Here to be the decoder's opposite: a round trip through both is a test that
 * needs no hardware and no recorded sample, and it is the only way to prove
 * the bit layout without a box on the desk.
 *
 * It is also the start of the other half of this feature. A tablet that can
 * WRITE this signal can jam a slate from the headphone jack, which is the same
 * cable pointed the other way.
 */
export function encodeFrame(f: LtcFrame): number[] {
  const bits = new Array<number>(LTC_FRAME_BITS).fill(0);
  const put = (start: number, count: number, value: number) => {
    for (let i = 0; i < count; i += 1) bits[start + i] = (value >> i) & 1;
  };

  put(0, 4, f.frames % 10);
  put(8, 2, Math.floor(f.frames / 10));
  put(16, 4, f.seconds % 10);
  put(24, 3, Math.floor(f.seconds / 10));
  put(32, 4, f.minutes % 10);
  put(40, 3, Math.floor(f.minutes / 10));
  put(48, 4, f.hours % 10);
  put(56, 2, Math.floor(f.hours / 10));

  bits[10] = f.dropFrame ? 1 : 0;
  bits[11] = f.colourFrame ? 1 : 0;

  const ub = (f.userBits || '00000000').padStart(8, '0').slice(-8);
  const groups = [4, 12, 20, 28, 36, 44, 52, 60];
  for (let g = 0; g < 8; g += 1) {
    // userBits reads most-significant group first; the bit fields run the
    // other way, which is why this indexes from the end.
    put(groups[g]!, 4, parseInt(ub[7 - g]!, 16) || 0);
  }

  for (let i = 0; i < SYNC_WORD.length; i += 1) bits[64 + i] = SYNC_WORD[i]!;
  return bits;
}

/**
 * Bits back to transition gaps, for the round trip.
 *
 * The mirror of bitsFromIntervals: a zero is one whole-bit gap, a one is two
 * halves. Feeding this straight back in must return what went in, and any
 * disagreement about what a half is shows up immediately.
 */
export function intervalsFromBits(
  bits: readonly number[], samplesPerBit: number,
): number[] {
  const out: number[] = [];
  for (const b of bits) {
    if (b === 1) { out.push(samplesPerBit / 2, samplesPerBit / 2); } else { out.push(samplesPerBit); }
  }
  return out;
}

/** Samples per bit, from the audio hardware and the frame rate. */
export function samplesPerBit(sampleRate: number, framesPerSecond: number): number {
  return sampleRate / (framesPerSecond * LTC_FRAME_BITS);
}
