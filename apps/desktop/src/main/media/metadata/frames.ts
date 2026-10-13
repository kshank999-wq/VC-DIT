import type { FileHandle } from 'node:fs/promises';

/**
 * Timecode and frame rate from one frame of a DPX or OpenEXR sequence, from
 * the fields their published specifications define:
 *
 * - DPX (SMPTE 268M): the magic number "SDPX" (big-endian) or "XPDS"
 *   (little-endian); the TV header's time code, a 32-bit BCD HH MM SS FF, at
 *   byte 1920 (all ones when unset); the frame rate in the film header at
 *   1724, else the TV header's temporal sampling rate at 1940 (32-bit floats).
 * - OpenEXR: the header's attributes after the magic 0x762f3101 and version;
 *   "timeCode" (type timecode: SMPTE 12M time-and-flags, then user data) and
 *   "framesPerSecond" (type rational: signed numerator, unsigned denominator).
 */

export interface FrameInfo {
  timecode: { frames: number; base: number; dropFrame: boolean } | null;
  rate: { num: number; den: number } | null;
}

const NTSC: [number, number, number][] = [
  [23.976, 24000, 1001],
  [29.97, 30000, 1001],
  [47.952, 48000, 1001],
  [59.94, 60000, 1001],
];

/** A rate written as a decimal, as the fraction editors use: 23.976 → 24000/1001. */
export const rateOfDecimal = (fps: number): { num: number; den: number } | null => {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 1000) return null;
  const ntsc = NTSC.find(([value]) => Math.abs(value - fps) < 0.01);
  if (ntsc) return { num: ntsc[1], den: ntsc[2] };
  return Number.isInteger(Math.round(fps * 1000) / 1000) ? { num: Math.round(fps), den: 1 } : { num: Math.round(fps * 1000), den: 1000 };
};

const frameCount = (h: number, m: number, s: number, f: number, base: number, dropFrame: boolean) => {
  const drop = dropFrame && base % 30 === 0 ? (base / 30) * 2 : 0;
  const minutes = h * 60 + m;
  return (minutes * 60 + s) * base + f - drop * (minutes - Math.floor(minutes / 10));
};

const read = async (file: FileHandle, position: number, length: number) => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
};

export const readDpxInfo = async (file: FileHandle): Promise<FrameInfo> => {
  const header = await read(file, 0, 2048);
  const magic = header.toString('latin1', 0, 4);
  if (magic !== 'SDPX' && magic !== 'XPDS') throw new Error('Not a DPX file.');
  if (header.length < 1944) throw new Error('This DPX header is cut short.');
  const big = magic === 'SDPX';
  const u32 = (at: number) => (big ? header.readUInt32BE(at) : header.readUInt32LE(at));
  const f32 = (at: number) => (big ? header.readFloatBE(at) : header.readFloatLE(at));
  const rate = rateOfDecimal(f32(1724)) ?? rateOfDecimal(f32(1940));
  const word = u32(1920);
  let timecode: FrameInfo['timecode'] = null;
  if (word !== 0xffffffff) {
    const bcd = (shift: number) => ((word >> (shift + 4)) & 0xf) * 10 + ((word >> shift) & 0xf);
    const [h, m, s, f] = [bcd(24), bcd(16), bcd(8), bcd(0)];
    const base = rate ? Math.round(rate.num / rate.den) : 24;
    if (h < 24 && m < 60 && s < 60 && f < base) timecode = { frames: frameCount(h, m, s, f, base, false), base, dropFrame: false };
  }
  return { timecode, rate };
};

export const readExrInfo = async (file: FileHandle): Promise<FrameInfo> => {
  const header = await read(file, 0, 64 * 1024);
  if (header.length < 8 || header.readUInt32LE(0) !== 20000630) throw new Error('Not an OpenEXR file.');
  let at = 8;
  const text = () => {
    const end = header.indexOf(0, at);
    if (end < 0) throw new Error('This OpenEXR header is cut short.');
    const value = header.toString('latin1', at, end);
    at = end + 1;
    return value;
  };
  let rate: FrameInfo['rate'] = null;
  let packed: number | null = null;
  for (;;) {
    const name = text();
    if (!name) break;
    const type = text();
    if (at + 4 > header.length) throw new Error('This OpenEXR header is cut short.');
    const size = header.readInt32LE(at);
    at += 4;
    if (size < 0 || at + size > header.length) throw new Error('This OpenEXR header is cut short.');
    if (name === 'framesPerSecond' && type === 'rational' && size === 8) {
      const num = header.readInt32LE(at);
      const den = header.readUInt32LE(at + 4);
      if (num > 0 && den > 0) rate = { num, den };
    } else if (name === 'timeCode' && type === 'timecode' && size === 8) {
      packed = header.readUInt32LE(at);
    }
    at += size;
  }
  let timecode: FrameInfo['timecode'] = null;
  if (packed !== null) {
    const bits = (shift: number, count: number) => (packed! >>> shift) & ((1 << count) - 1);
    const dropFrame = bits(6, 1) === 1;
    const f = bits(0, 4) + 10 * bits(4, 2);
    const s = bits(8, 4) + 10 * bits(12, 3);
    const m = bits(16, 4) + 10 * bits(20, 3);
    const h = bits(24, 4) + 10 * bits(28, 2);
    const base = rate ? Math.round(rate.num / rate.den) : 24;
    if (h < 24 && m < 60 && s < 60 && f < Math.max(base, 30)) timecode = { frames: frameCount(h, m, s, f, base, dropFrame), base, dropFrame };
  }
  return { timecode, rate };
};
