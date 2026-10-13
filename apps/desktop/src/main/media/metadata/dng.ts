import type { FileHandle } from 'node:fs/promises';

/**
 * CinemaDNG: each frame a DNG (a TIFF), its timecode and frame rate in the
 * first image's tags (DNG 1.4: TimeCodes 51043, eight bytes of SMPTE 12M
 * each; FrameRate 51044, a signed rational). Read from the sequence's first
 * frame; the clip's length is its number of frames at that rate.
 */

const TIME_CODES = 51043;
const FRAME_RATE = 51044;

export interface DngInfo {
  timecode: { frames: number; base: number; dropFrame: boolean } | null;
  rate: { num: number; den: number } | null;
}

const bcd = (byte: number, tensMask: number) => (byte & 0x0f) + 10 * ((byte >> 4) & tensMask);

export const readDngInfo = async (file: FileHandle): Promise<DngInfo> => {
  const read = async (position: number, length: number) => {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  };
  const head = await read(0, 8);
  const little = head.toString('latin1', 0, 2) === 'II';
  if (!little && head.toString('latin1', 0, 2) !== 'MM') throw new Error('Not a DNG (TIFF) file.');
  const u16 = (buffer: Buffer, at: number) => (little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
  const u32 = (buffer: Buffer, at: number) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
  const i32 = (buffer: Buffer, at: number) => (little ? buffer.readInt32LE(at) : buffer.readInt32BE(at));
  if (u16(head, 2) !== 42) throw new Error('Not a DNG (TIFF) file.');
  const ifd = u32(head, 4);
  const count = u16(await read(ifd, 2), 0);
  const entries = await read(ifd + 2, count * 12);
  let rate: DngInfo['rate'] = null;
  let codes: Buffer | null = null;
  for (let i = 0; i < count; i += 1) {
    const at = i * 12;
    const tag = u16(entries, at);
    const items = u32(entries, at + 4);
    if (tag === FRAME_RATE && items >= 1) {
      const value = await read(u32(entries, at + 8), 8);
      const num = i32(value, 0);
      const den = i32(value, 4);
      if (num > 0 && den > 0) rate = { num, den };
    } else if (tag === TIME_CODES && items >= 8) {
      codes = await read(u32(entries, at + 8), 8);
    }
  }
  let timecode: DngInfo['timecode'] = null;
  if (codes && codes.length === 8) {
    const fps = rate ? rate.num / rate.den : 24;
    const base = Math.round(fps);
    const dropFrame = (codes[0]! & 0x40) !== 0;
    const f = bcd(codes[0]!, 0x03);
    const s = bcd(codes[1]!, 0x07);
    const m = bcd(codes[2]!, 0x07);
    const h = bcd(codes[3]!, 0x03);
    const drop = dropFrame && base % 30 === 0 ? (base / 30) * 2 : 0;
    const minutes = h * 60 + m;
    timecode = { frames: (minutes * 60 + s) * base + f - drop * (minutes - Math.floor(minutes / 10)), base, dropFrame };
  }
  return { timecode, rate };
};
