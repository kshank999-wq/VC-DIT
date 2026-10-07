import type { FileHandle } from 'node:fs/promises';
import { decodePcm } from './wav';

/**
 * MXF camera files (ARRI, Sony, Canon, Panasonic): the start timecode, the
 * picture rate, the length, and the uncompressed scratch audio. MXF is a run
 * of KLV packets (16-byte key, BER length, value); the header metadata near
 * the start describes the essence, and the body interleaves picture and
 * sound elements. Picture elements are skipped by their length, never read.
 */

export interface MxfInfo {
  rate: { num: number; den: number } | null;
  durationSec: number;
  timecode: { frames: number; base: number; dropFrame: boolean } | null;
  audio: { sampleRate: number; channels: number; bits: number } | null;
}

const PREFIX = Buffer.from('060e2b34', 'hex');
const PARTITION = Buffer.from('060e2b34020501010d010201', 'hex');
const TIMECODE_COMPONENT = '060e2b34025301010d01010101011400';
/** Generic container sound element: 06.0e.2b.34.01.02.01.01.0d.01.03.01.16.{count}.{type}.{number}. */
const SOUND_ELEMENT = Buffer.from('060e2b34010201010d01030116', 'hex');

interface Klv {
  key: Buffer;
  /** Where the value starts, and its length. */
  at: number;
  length: number;
}

/** The KLV packet at `position`, or null past the end or on something that is not one. */
const klvAt = async (file: FileHandle, position: number, size: number): Promise<Klv | null> => {
  if (position + 17 > size) return null;
  const head = Buffer.alloc(25);
  await file.read(head, 0, 25, position);
  if (!head.subarray(0, 4).equals(PREFIX)) return null;
  const first = head[16]!;
  let length = first;
  let berBytes = 1;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (count === 0 || count > 8) return null;
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + head[17 + i]!;
    berBytes = 1 + count;
  }
  return { key: head.subarray(0, 16), at: position + 16 + berBytes, length };
};

/** A local set's tags: 2-byte tag, 2-byte length, value. */
const localTags = (value: Buffer): Map<number, Buffer> => {
  const tags = new Map<number, Buffer>();
  let at = 0;
  while (at + 4 <= value.length) {
    const tag = value.readUInt16BE(at);
    const length = value.readUInt16BE(at + 2);
    tags.set(tag, value.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return tags;
};

const rational = (value: Buffer | undefined) => (value && value.length >= 8 ? { num: value.readInt32BE(0), den: value.readInt32BE(4) } : null);
const int64 = (value: Buffer | undefined) => (value && value.length >= 8 ? Number(value.readBigInt64BE(0)) : null);

/** Where the first partition starts: after any run-in (up to 64 KB). */
const firstPartition = async (file: FileHandle): Promise<number> => {
  const head = Buffer.alloc(65536 + 16);
  const { bytesRead } = await file.read(head, 0, head.length, 0);
  const at = head.subarray(0, bytesRead).indexOf(PARTITION);
  if (at < 0) throw new Error('Not an MXF file.');
  return at;
};

/** The header metadata: reads KLV packets from the start until the first essence. */
export const readMxfInfo = async (file: FileHandle): Promise<MxfInfo> => {
  const size = (await file.stat()).size;
  let position = await firstPartition(file);
  const timecodes: { frames: number; base: number; dropFrame: boolean; duration: number | null }[] = [];
  let picture: { rate: { num: number; den: number } | null; duration: number | null } | null = null;
  let audio: MxfInfo['audio'] = null;
  for (let packets = 0; packets < 20000; packets += 1) {
    const klv = await klvAt(file, position, size);
    if (!klv) break;
    const key = klv.key.toString('hex');
    // Essence reached: the header metadata is behind us.
    if (klv.key.subarray(0, 12).equals(SOUND_ELEMENT.subarray(0, 12)) && klv.key[4] === 0x01) break;
    // Header metadata sets are local sets (byte 5 = 0x53); keep their value small.
    if (klv.key[4] === 0x02 && klv.key[5] === 0x53 && klv.length < 65536) {
      const value = Buffer.alloc(klv.length);
      await file.read(value, 0, klv.length, klv.at);
      const tags = localTags(value);
      if (key === TIMECODE_COMPONENT) {
        const start = int64(tags.get(0x1501));
        const base = tags.get(0x1502)?.readUInt16BE(0);
        if (start !== null && base) timecodes.push({ frames: start, base, dropFrame: tags.get(0x1503)?.[0] === 1, duration: int64(tags.get(0x0202)) });
      } else if (tags.has(0x3d03)) {
        // A sound descriptor (wave or AES3): rate, channels, bits.
        const rate = rational(tags.get(0x3d03));
        audio ??= {
          sampleRate: rate && rate.den ? rate.num / rate.den : 48000,
          channels: tags.get(0x3d07)?.readUInt32BE(0) ?? 1,
          bits: tags.get(0x3d01)?.readUInt32BE(0) ?? 24,
        };
      } else if (tags.has(0x3201) || tags.has(0x3203) || tags.has(0x3202)) {
        // A picture descriptor: its sample rate is the frame rate, its container duration the length.
        picture ??= { rate: rational(tags.get(0x3001)), duration: int64(tags.get(0x3002)) };
      }
    }
    position = klv.at + klv.length;
  }
  // The source package's timecode is the camera's; a material package's may start at zero.
  const timecode = [...timecodes].reverse().find((candidate) => candidate.frames > 0) ?? timecodes[0] ?? null;
  const rate = picture?.rate && picture.rate.den ? picture.rate : null;
  const frames = picture?.duration ?? timecode?.duration ?? null;
  return {
    rate,
    durationSec: frames && rate ? (frames * rate.den) / rate.num : 0,
    timecode: timecode ? { frames: timecode.frames, base: timecode.base, dropFrame: timecode.dropFrame } : null,
    audio,
  };
};

/** Up to `seconds` of the first sound track, one channel or all mixed. Picture is skipped by its length. */
export const readMxfAudio = async (file: FileHandle, info: MxfInfo, seconds: number, channel: number | 'mix' = 'mix'): Promise<Float32Array> => {
  if (!info.audio) return new Float32Array(0);
  const { sampleRate, channels, bits } = info.audio;
  const frameBytes = (bits / 8) * channels;
  const wanted = Math.floor(seconds * sampleRate) * frameBytes;
  const size = (await file.stat()).size;
  const parts: Buffer[] = [];
  let have = 0;
  let track: number | null = null;
  let position = await firstPartition(file);
  for (let packets = 0; have < wanted && packets < 2_000_000; packets += 1) {
    const klv = await klvAt(file, position, size);
    if (!klv) break;
    if (klv.key.subarray(0, 13).equals(SOUND_ELEMENT)) {
      // The first sound track found is the one read; its element number identifies it.
      track ??= klv.key[15]!;
      if (klv.key[15] === track && klv.key[14]! <= 0x04) {
        const length = Math.min(klv.length, wanted - have + frameBytes);
        const value = Buffer.alloc(length - (length % frameBytes));
        await file.read(value, 0, value.length, klv.at);
        parts.push(value);
        have += value.length;
      }
    }
    position = klv.at + klv.length;
  }
  return decodePcm(Buffer.concat(parts), channels, bits, 1, channel, 'le');
};
