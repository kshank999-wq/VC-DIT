import { describe, expect, it } from 'vitest';
import { encodeFrame, samplesPerBit, type LtcFrame } from '../timecode/ltc';
import { blockSamplesFor, crossings, freshCrossings, freshReader, readBlock, readerHealth } from '../timecode/ltc-reader';
import { clock, rateOfProduction, stampAt, type ClockState } from '../timecode/clock';
import { timecodeAt } from '../timecode/timecode';

/**
 * The timecode reader ported from VC Film Studio: a sync box's LTC on an
 * audio input, decoded; and a display that never claims to be live when it
 * is not.
 */

const RATE = 48000;
const FPS = 25;
const SPB = samplesPerBit(RATE, FPS);
const frame = (h: number, m: number, s: number, f: number): LtcFrame => ({ hours: h, minutes: m, seconds: s, frames: f, dropFrame: false, colourFrame: false, userBits: '00000000' });

/** Bits as the biphase-mark square wave a box puts out. */
const waveform = (bits: number[], amplitude = 0.5) => {
  const out: number[] = [];
  let level = 1;
  const run = (n: number) => {
    for (let i = 0; i < n; i += 1) out.push(level * amplitude);
  };
  for (const bit of bits) {
    level = -level;
    run(SPB / 2);
    if (bit === 1) level = -level;
    run(SPB / 2);
  }
  return Float32Array.from(out);
};

/** A stretch of a running signal: padded both ends, as a cable delivers it. */
const signal = (...frames: LtcFrame[]) => waveform([...encodeFrame(frame(0, 0, 0, 0)), ...frames.flatMap((f) => encodeFrame(f)), 0, 0, 0, 0, 0, 0, 0, 0]);

describe('the LTC reader', () => {
  it('reads the timecode off the cable, even clipped hard', () => {
    for (const amplitude of [0.5, 1]) {
      const samples = signal(frame(14, 5, 40, 11), frame(14, 5, 40, 12), frame(14, 5, 40, 13));
      const scaled = samples.map((value) => Math.max(-1, Math.min(1, value * amplitude * 4)));
      const c = crossings(scaled, freshCrossings());
      const reader = readBlock(freshReader(), c.intervals, SPB, c.state.peak, 1000);
      expect(reader.framesRead).toBeGreaterThan(0);
      expect(readerHealth(reader, 1010)).toMatchObject({ state: 'locked', timecode: '14:05:40:13' });
    }
  });

  it('never shows a stopped signal as live: locked, then lost with its age, silent and noise kept apart', () => {
    const c = crossings(signal(frame(10, 0, 0, 1), frame(10, 0, 0, 2)), freshCrossings());
    const reader = readBlock(freshReader(), c.intervals, SPB, c.state.peak, 5000);
    expect(readerHealth(reader, 5100).state).toBe('locked');
    const later = readerHealth(reader, 6000);
    expect(later).toMatchObject({ state: 'lost', agoMs: 1000 });
    expect(later).not.toHaveProperty('frame');

    expect(readerHealth(freshReader(), 0).state).toBe('silent');
    const hiss = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i * 1.3) * 0.2);
    const h = crossings(hiss, freshCrossings());
    expect(readerHealth(readBlock(freshReader(), h.intervals, SPB, h.state.peak, 0), 0).state).toBe('noise');
  });

  it('gathers three frames of audio at a time, so a block always holds a whole one', () => {
    expect(blockSamplesFor(48000, 25)).toBe(5760);
    expect(blockSamplesFor(0, 25)).toBe(8192);
  });
});

describe('free-running from a jam', () => {
  it('carries the timecode on by the clock, at the production rate', () => {
    expect(timecodeAt({ timecode: '10:00:00:00', atEpochMs: 0, rateKey: '25' }, 2000)).toBe('10:00:02:00');
    expect(timecodeAt({ timecode: '10:00:00:00', atEpochMs: 0, rateKey: '25' }, 2040)).toBe('10:00:02:01');
  });

  it("reads the production's rate as the clock's: 29.97 and 59.94 drop-frame unless marked NDF", () => {
    expect(rateOfProduction('23.976 fps')).toBe('23.976');
    expect(rateOfProduction('25 fps')).toBe('25');
    expect(rateOfProduction('29.97 fps')).toBe('29.97df');
    expect(rateOfProduction('29.97 fps NDF')).toBe('29.97');
  });
});

describe('what a note is stamped with', () => {
  const base: ClockState = { ...clock.get(), source: 'clock', rateKey: '25', jam: null, health: null };
  it('says where each timecode came from, and never calls a free run live', () => {
    const at = new Date(2026, 9, 7, 14, 5, 40, 480).getTime();
    expect(stampAt(at, base)).toEqual({ tc: '14:05:40:12', source: 'clock', rate: '25' });
    const jam = { timecode: '10:00:00:00', atEpochMs: at, rateKey: '25' as const };
    expect(stampAt(at + 1000, { ...base, source: 'jam', jam })).toEqual({ tc: '10:00:01:00', source: 'jam', rate: '25' });
    expect(stampAt(at + 40, { ...base, source: 'ltc', jam, health: { state: 'locked', says: '', timecode: '10:00:00:00', frame: {} as never } }).source).toBe('ltc');
    expect(stampAt(at + 5000, { ...base, source: 'ltc', jam, health: { state: 'lost', says: '', timecode: '10:00:00:00', agoMs: 5000 } })).toEqual({ tc: '10:00:05:00', source: 'free-run', rate: '25' });
    expect(stampAt(at, { ...base, source: 'ltc', jam: null }).tc).toBeNull();
  });

  it('refuses a hand jam that is not a timecode', () => {
    clock.setRate('25');
    expect(clock.jam('14:05')).toMatch(/not a timecode/);
    expect(clock.jam('14:05:40:12')).toBeNull();
    expect(clock.get()).toMatchObject({ source: 'jam', jam: { timecode: '14:05:40:12', rateKey: '25' } });
    clock.setSource('clock');
  });
});
