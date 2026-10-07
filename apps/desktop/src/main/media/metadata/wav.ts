import type { FileHandle } from 'node:fs/promises';

/**
 * Production sound files: WAV and Broadcast WAV (spec §4.6). From the
 * header only: the format, how long it runs, the timecode it starts at (the
 * bext chunk's time reference, in samples since midnight) and the iXML the
 * recorder wrote (scene, take, roll, frame rate, track names).
 */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 1 integer PCM, 3 float. */
  encoding: 1 | 3;
  dataOffset: number;
  dataBytes: number;
  durationSec: number;
  /** Samples since midnight at which the recording starts; null without a bext chunk. */
  timeReference: number | null;
  ixml: { scene: string; take: string; tape: string; rate: string; tracks: string[] } | null;
}

const text = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml)?.[1]?.trim() ?? '';

/** Reads the chunks before the audio; throws when this is not a WAV it can read. */
export const readWavInfo = async (file: FileHandle): Promise<WavInfo> => {
  const head = Buffer.alloc(12);
  await file.read(head, 0, 12, 0);
  const riff = head.toString('ascii', 0, 4);
  if ((riff !== 'RIFF' && riff !== 'RF64') || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file.');
  const size = (await file.stat()).size;

  let format: Omit<WavInfo, 'dataOffset' | 'dataBytes' | 'durationSec' | 'timeReference' | 'ixml'> | null = null;
  let timeReference: number | null = null;
  let ixml: WavInfo['ixml'] = null;
  let ds64Data: number | null = null;
  let position = 12;
  const header = Buffer.alloc(8);
  while (position + 8 <= size) {
    await file.read(header, 0, 8, position);
    const id = header.toString('ascii', 0, 4);
    let length = header.readUInt32LE(4);
    const body = position + 8;
    if (id === 'data') {
      if (length === 0xffffffff && ds64Data !== null) length = ds64Data;
      if (!format) throw new Error('This WAV has no format chunk before its audio.');
      const dataBytes = Math.min(length, size - body);
      return {
        ...format,
        dataOffset: body,
        dataBytes,
        durationSec: dataBytes / (format.sampleRate * format.channels * (format.bitsPerSample / 8)),
        timeReference,
        ixml,
      };
    }
    if (id === 'fmt ' || id === 'bext' || id === 'iXML' || id === 'ds64') {
      const chunk = Buffer.alloc(Math.min(length, 1 << 20));
      await file.read(chunk, 0, chunk.length, body);
      if (id === 'fmt ') {
        let tag = chunk.readUInt16LE(0);
        // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format GUID's first two bytes.
        if (tag === 0xfffe && chunk.length >= 26) tag = chunk.readUInt16LE(24);
        if (tag !== 1 && tag !== 3) throw new Error('This WAV is compressed; only PCM sound can be synced.');
        format = { encoding: tag, channels: chunk.readUInt16LE(2), sampleRate: chunk.readUInt32LE(4), bitsPerSample: chunk.readUInt16LE(14) };
      } else if (id === 'bext' && chunk.length >= 346) {
        timeReference = Number(chunk.readBigUInt64LE(338));
      } else if (id === 'ds64' && chunk.length >= 24) {
        ds64Data = Number(chunk.readBigUInt64LE(16));
      } else if (id === 'iXML') {
        const xml = chunk.toString('utf8');
        ixml = {
          scene: text(xml, 'SCENE'),
          take: text(xml, 'TAKE'),
          tape: text(xml, 'TAPE'),
          rate: text(xml, 'TIMECODE_RATE'),
          tracks: [...xml.matchAll(/<TRACK>([\s\S]*?)<\/TRACK>/gi)].map((track) => text(track[1]!, 'NAME')),
        };
      }
    }
    position = body + length + (length % 2);
  }
  throw new Error('This WAV has no audio.');
};

/** One channel (or all of them mixed), from `startSec` for up to `seconds`, as floats in −1…1. */
export const readWavSamples = async (file: FileHandle, info: WavInfo, startSec: number, seconds: number, channel: number | 'mix' = 'mix'): Promise<Float32Array> => {
  const width = info.bitsPerSample / 8;
  const frame = width * info.channels;
  const first = Math.max(0, Math.floor(startSec * info.sampleRate));
  const total = Math.floor(info.dataBytes / frame);
  const count = Math.max(0, Math.min(total - first, Math.floor(seconds * info.sampleRate)));
  const bytes = Buffer.alloc(count * frame);
  await file.read(bytes, 0, bytes.length, info.dataOffset + first * frame);
  return decodePcm(bytes, info.channels, info.bitsPerSample, info.encoding, channel, 'le');
};

/** Interleaved PCM to floats. */
export const decodePcm = (
  bytes: Buffer,
  channels: number,
  bits: number,
  encoding: 1 | 3,
  channel: number | 'mix',
  endian: 'le' | 'be',
): Float32Array => {
  const width = bits / 8;
  const frames = Math.floor(bytes.length / (width * channels));
  const out = new Float32Array(frames);
  const sample = (offset: number): number => {
    if (encoding === 3) return width === 8 ? (endian === 'le' ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset)) : endian === 'le' ? bytes.readFloatLE(offset) : bytes.readFloatBE(offset);
    switch (width) {
      case 1:
        return (bytes[offset]! - 128) / 128;
      case 2:
        return (endian === 'le' ? bytes.readInt16LE(offset) : bytes.readInt16BE(offset)) / 32768;
      case 3:
        return (endian === 'le' ? bytes.readIntLE(offset, 3) : bytes.readIntBE(offset, 3)) / 8388608;
      default:
        return (endian === 'le' ? bytes.readInt32LE(offset) : bytes.readInt32BE(offset)) / 2147483648;
    }
  };
  for (let i = 0; i < frames; i += 1) {
    const base = i * width * channels;
    if (channel === 'mix') {
      let sum = 0;
      for (let c = 0; c < channels; c += 1) sum += sample(base + c * width);
      out[i] = sum / channels;
    } else out[i] = sample(base + Math.min(channel, channels - 1) * width);
  }
  return out;
};
