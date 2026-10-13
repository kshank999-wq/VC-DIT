import type { FileHandle } from 'node:fs/promises';
import { decodePcm } from './wav';

/**
 * QuickTime and MP4 camera files (ProRes .mov, H.264/HEVC .mp4): the frame
 * rate, the duration, the timecode track (tmcd) and the uncompressed scratch
 * audio, read from the movie's atoms and the few bytes they point at. The
 * picture itself is never read.
 */

export interface AudioTrack {
  sampleRate: number;
  channels: number;
  bits: number;
  encoding: 1 | 3;
  endian: 'le' | 'be';
  /** Where the audio is in the file, in order: byte offset and the number of sample frames there. */
  chunks: { offset: number; frames: number }[];
}

export interface QuickTimeInfo {
  /** Picture rate as a fraction: 24000/1001. */
  rate: { num: number; den: number } | null;
  durationSec: number;
  /** The timecode track's first frame count, its timebase (24, 25, 30…) and drop-frame flag. */
  timecode: { frames: number; base: number; dropFrame: boolean } | null;
  audio: AudioTrack | null;
}

interface Atom {
  type: string;
  start: number;
  size: number;
  body: Buffer;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);

/** The atoms in a buffer, one level. */
const atomsIn = (buffer: Buffer, from = 0, to = buffer.length): Atom[] => {
  const atoms: Atom[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1 && at + 16 <= to) {
      size = Number(buffer.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) break;
    atoms.push({ type, start: at, size, body: buffer.subarray(at + header, at + size) });
    at += size;
  }
  return atoms;
};

const child = (atom: Atom | undefined, type: string): Atom | undefined => (atom ? atomsIn(atom.body).find((item) => item.type === type) : undefined);
const path = (atom: Atom | undefined, ...types: string[]): Atom | undefined => types.reduce<Atom | undefined>((current, type) => child(current, type), atom);

/** Find the movie atom: top level, wherever it is in the file. */
const readMoov = async (file: FileHandle): Promise<Atom> => {
  const size = (await file.stat()).size;
  const header = Buffer.alloc(16);
  let at = 0;
  while (at + 8 <= size) {
    await file.read(header, 0, 16, at);
    let length = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    if (length === 1) length = Number(header.readBigUInt64BE(8));
    else if (length === 0) length = size - at;
    if (length < 8) break;
    if (type === 'moov') {
      if (length > 256 * 1024 * 1024) throw new Error('The movie header is too large to read.');
      const body = Buffer.alloc(length);
      await file.read(body, 0, length, at);
      return atomsIn(body)[0]!;
    }
    at += length;
  }
  throw new Error('Not a QuickTime or MP4 file (no movie header).');
};

const timescaleAndDuration = (mdhd: Atom): { timescale: number; duration: number } => {
  const version = mdhd.body[0];
  return version === 1
    ? { timescale: mdhd.body.readUInt32BE(20), duration: Number(mdhd.body.readBigUInt64BE(24)) }
    : { timescale: mdhd.body.readUInt32BE(12), duration: mdhd.body.readUInt32BE(16) };
};

const chunkOffsets = (stbl: Atom): number[] => {
  const stco = child(stbl, 'stco');
  if (stco) return Array.from({ length: stco.body.readUInt32BE(4) }, (_, i) => stco.body.readUInt32BE(8 + i * 4));
  const co64 = child(stbl, 'co64');
  if (co64) return Array.from({ length: co64.body.readUInt32BE(4) }, (_, i) => Number(co64.body.readBigUInt64BE(8 + i * 8)));
  return [];
};

/** Samples in each chunk, from the sample-to-chunk table. */
const samplesPerChunk = (stbl: Atom, chunks: number): number[] => {
  const stsc = child(stbl, 'stsc');
  if (!stsc) return [];
  const entries = Array.from({ length: stsc.body.readUInt32BE(4) }, (_, i) => ({
    first: stsc.body.readUInt32BE(8 + i * 12),
    count: stsc.body.readUInt32BE(12 + i * 12),
  }));
  return Array.from({ length: chunks }, (_, index) => {
    const number = index + 1;
    let count = 0;
    for (const entry of entries) if (entry.first <= number) count = entry.count;
    return count;
  });
};

const soundFormat = (entry: Buffer): Omit<AudioTrack, 'chunks'> & { framesPerSample: number } | null => {
  // entry: size(4) format(4) reserved(6) dataRefIndex(2), then the sound description.
  const format = entry.toString('latin1', 4, 8);
  const version = entry.readUInt16BE(16);
  let channels = entry.readUInt16BE(24);
  let bits = entry.readUInt16BE(26);
  let sampleRate = entry.readUInt32BE(32) / 65536;
  let flags = 0;
  if (version === 2) {
    sampleRate = entry.readDoubleBE(40);
    channels = entry.readUInt32BE(48);
    bits = entry.readUInt32BE(56);
    flags = entry.readUInt32BE(60);
  }
  // A little-endian flag in the 'wave' extension ("enda" = 1), as ffmpeg and Apple write for in24/in32/fl32.
  const enda = entry.indexOf('enda', 28, 'latin1');
  const little = enda >= 0 && entry.length >= enda + 6 && entry.readUInt16BE(enda + 4) === 1;
  switch (format) {
    case 'sowt':
      return { sampleRate, channels, bits: 16, encoding: 1, endian: 'le', framesPerSample: 1 };
    case 'twos':
      return { sampleRate, channels, bits: bits === 8 ? 8 : 16, encoding: 1, endian: 'be', framesPerSample: 1 };
    case 'in24':
      return { sampleRate, channels, bits: 24, encoding: 1, endian: little ? 'le' : 'be', framesPerSample: 1 };
    case 'in32':
      return { sampleRate, channels, bits: 32, encoding: 1, endian: little ? 'le' : 'be', framesPerSample: 1 };
    case 'fl32':
      return { sampleRate, channels, bits: 32, encoding: 3, endian: little ? 'le' : 'be', framesPerSample: 1 };
    case 'fl64':
      return { sampleRate, channels, bits: 64, encoding: 3, endian: little ? 'le' : 'be', framesPerSample: 1 };
    case 'lpcm':
      // kAudioFormatFlagIsFloat = 1, IsBigEndian = 2.
      return { sampleRate, channels, bits, encoding: flags & 1 ? 3 : 1, endian: flags & 2 ? 'be' : 'le', framesPerSample: 1 };
    case 'ipcm': {
      const pcmC = entry.indexOf('pcmC', 28, 'latin1');
      const littleEndian = pcmC >= 0 && (entry[pcmC + 8]! & 1) === 1;
      const size = pcmC >= 0 ? entry[pcmC + 9]! : bits;
      return { sampleRate, channels, bits: size, encoding: 1, endian: littleEndian ? 'le' : 'be', framesPerSample: 1 };
    }
    default:
      // AAC and other compressed sound: no waveform without a decoder.
      return null;
  }
};

export const readQuickTimeInfo = async (file: FileHandle): Promise<QuickTimeInfo> => {
  const moov = await readMoov(file);
  const info: QuickTimeInfo = { rate: null, durationSec: 0, timecode: null, audio: null };
  const mvhd = child(moov, 'mvhd');
  if (mvhd) {
    const { timescale, duration } = timescaleAndDuration(mvhd);
    if (timescale) info.durationSec = duration / timescale;
  }
  for (const trak of atomsIn(moov.body).filter((atom) => atom.type === 'trak')) {
    const handler = path(trak, 'mdia', 'hdlr')?.body.toString('latin1', 8, 12);
    const mdhd = path(trak, 'mdia', 'mdhd');
    const stbl = path(trak, 'mdia', 'minf', 'stbl');
    const stsd = child(stbl, 'stsd');
    if (!mdhd || !stbl || !stsd || stsd.body.length < 16) continue;
    const { timescale, duration } = timescaleAndDuration(mdhd);
    const entry = stsd.body.subarray(8, 8 + stsd.body.readUInt32BE(8));

    if (handler === 'vide' && !info.rate) {
      const stts = child(stbl, 'stts');
      const delta = stts && stts.body.readUInt32BE(4) > 0 ? stts.body.readUInt32BE(12) : 0;
      if (delta && timescale) {
        const divisor = gcd(timescale, delta);
        info.rate = { num: timescale / divisor, den: delta / divisor };
      }
      if (timescale && duration) info.durationSec = duration / timescale;
    } else if (handler === 'tmcd' && !info.timecode && entry.length >= 34) {
      // tmcd: reserved(4) flags(4) timescale(4) frameDuration(4) numberOfFrames(1).
      const flags = entry.readUInt32BE(20);
      const base = entry[32]! || Math.round(entry.readUInt32BE(24) / entry.readUInt32BE(28));
      const offset = chunkOffsets(stbl)[0];
      if (offset !== undefined) {
        const first = Buffer.alloc(4);
        await file.read(first, 0, 4, offset);
        info.timecode = { frames: first.readUInt32BE(0), base, dropFrame: (flags & 1) === 1 };
      }
    } else if (handler === 'soun' && !info.audio && entry.length >= 36) {
      const format = soundFormat(entry);
      if (!format) continue;
      const offsets = chunkOffsets(stbl);
      const counts = samplesPerChunk(stbl, offsets.length);
      const { framesPerSample, ...track } = format;
      info.audio = { ...track, chunks: offsets.map((offset, index) => ({ offset, frames: (counts[index] ?? 0) * framesPerSample })) };
    }
  }
  return info;
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Up to `seconds` of the scratch audio from its start, one channel or all mixed. */
export const readQuickTimeAudio = async (file: FileHandle, audio: AudioTrack, seconds: number, channel: number | 'mix' = 'mix'): Promise<Float32Array> => {
  const frameBytes = (audio.bits / 8) * audio.channels;
  const wanted = Math.floor(seconds * audio.sampleRate);
  const parts: Float32Array[] = [];
  let have = 0;
  for (const chunk of audio.chunks) {
    if (have >= wanted) break;
    const frames = Math.min(chunk.frames, wanted - have);
    const bytes = Buffer.alloc(frames * frameBytes);
    await file.read(bytes, 0, bytes.length, chunk.offset);
    parts.push(decodePcm(bytes, audio.channels, audio.bits, audio.encoding, channel, audio.endian));
    have += frames;
  }
  const out = new Float32Array(have);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
