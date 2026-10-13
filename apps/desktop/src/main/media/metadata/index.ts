import { open } from 'node:fs/promises';
import { readMxfAudio, readMxfInfo } from './mxf';
import { readQuickTimeAudio, readQuickTimeInfo } from './quicktime';
import { readWavInfo, readWavSamples } from './wav';
import { readDngInfo } from './dng';
import { readDpxInfo, readExrInfo } from './frames';
import { decodeLtc } from '../ltc';

/**
 * What VC DIT reads from a media file's header (spec "Clip / Audio File":
 * timecode, metadata): enough to sync picture and sound and to show start
 * timecode and length. Formats whose timecode lives in a vendor SDK (R3D,
 * BRAW, ARRIRAW .ari, Canon RAW) say so instead of guessing.
 */

export interface MediaMeta {
  kind: 'picture' | 'sound';
  format: 'QuickTime' | 'MXF' | 'WAV' | 'DNG' | 'DPX' | 'EXR';
  /** Picture: the first frame's timecode as a frame count at its timebase. */
  tc: { frames: number; base: number; dropFrame: boolean } | null;
  /** Where the timecode came from: the file's own (header) or LTC on one of its audio channels. */
  tcFrom?: 'header' | 'audio';
  /** An image sequence: this is its first frame, and durationSec is one frame (the clip is all its frames). */
  sequence?: boolean;
  /** Picture rate as a fraction. */
  rate: { num: number; den: number } | null;
  durationSec: number;
  /** Sound: when the recording starts, in seconds since midnight (bext time reference). */
  soundStartSec: number | null;
  sampleRate: number | null;
  channels: number | null;
  /** Readable PCM audio (camera scratch track, or the sound file itself). */
  hasAudio: boolean;
  /** From the recorder's iXML. */
  ixml: { scene: string; take: string; tape: string; rate: string; tracks: string[] } | null;
}

export type MetaResult = { ok: true; meta: MediaMeta } | { ok: false; error: string };

const extension = (path: string) => path.toLowerCase().split('.').pop() ?? '';

/** How much of a clip's sound is searched for LTC, on each channel: a few seconds is many frames of it. */
const LTC_SECONDS = 6;

/** The clip's timecode from LTC on one of its audio channels (the first that has it), or null. */
const ltcOf = async (read: (channel: number) => Promise<Float32Array>, channels: number, sampleRate: number, rate: { num: number; den: number } | null) => {
  for (let channel = 0; channel < Math.min(channels, 8); channel += 1) {
    const samples = await read(channel).catch(() => null);
    const found = samples ? decodeLtc(samples, sampleRate, rate ? rate.num / rate.den : null) : null;
    if (found) return found;
  }
  return null;
};
const NO_READER: Record<string, string> = {
  r3d: 'RED R3D timecode needs the RED SDK; sync these by waveform from a proxy, or manually.',
  braw: 'Blackmagic RAW timecode needs the Blackmagic SDK; sync these manually for now.',
  ari: "ARRIRAW (.ari) frame headers are ARRI's own and not read: sync these by waveform or by hand. ARRIRAW recorded as MXF has its timecode read, and FFmpeg cannot render .ari dailies (use the ARRIRAW Converter).",
  crm: 'Canon RAW timecode needs the Canon SDK; sync these manually for now.',
};

export const readMediaMeta = async (path: string): Promise<MetaResult> => {
  const type = extension(path);
  if (NO_READER[type]) return { ok: false, error: NO_READER[type]! };
  let file;
  try {
    file = await open(path, 'r');
  } catch (cause) {
    return { ok: false, error: `Could not open the file: ${(cause as Error).message}` };
  }
  try {
    if (type === 'wav' || type === 'bwf') {
      const info = await readWavInfo(file);
      return {
        ok: true,
        meta: {
          kind: 'sound',
          format: 'WAV',
          tc: null,
          rate: null,
          durationSec: info.durationSec,
          soundStartSec: info.timeReference === null ? null : info.timeReference / info.sampleRate,
          sampleRate: info.sampleRate,
          channels: info.channels,
          hasAudio: true,
          ixml: info.ixml,
        },
      };
    }
    if (type === 'mov' || type === 'mp4' || type === 'm4v') {
      const info = await readQuickTimeInfo(file);
      const audio = info.audio;
      const ltc = !info.timecode && audio && audio.chunks.length ? await ltcOf((channel) => readQuickTimeAudio(file!, audio, LTC_SECONDS, channel), audio.channels, audio.sampleRate, info.rate) : null;
      return {
        ok: true,
        meta: {
          kind: 'picture',
          format: 'QuickTime',
          tc: info.timecode ?? ltc,
          ...(info.timecode ? { tcFrom: 'header' as const } : ltc ? { tcFrom: 'audio' as const } : {}),
          rate: info.rate,
          durationSec: info.durationSec,
          soundStartSec: null,
          sampleRate: info.audio?.sampleRate ?? null,
          channels: info.audio?.channels ?? null,
          hasAudio: Boolean(info.audio && info.audio.chunks.length),
          ixml: null,
        },
      };
    }
    if (type === 'mxf') {
      const info = await readMxfInfo(file);
      const ltc = !info.timecode && info.audio ? await ltcOf((channel) => readMxfAudio(file!, info, LTC_SECONDS, channel), info.audio.channels, info.audio.sampleRate, info.rate) : null;
      return {
        ok: true,
        meta: {
          kind: 'picture',
          format: 'MXF',
          tc: info.timecode ?? ltc,
          ...(info.timecode ? { tcFrom: 'header' as const } : ltc ? { tcFrom: 'audio' as const } : {}),
          rate: info.rate,
          durationSec: info.durationSec,
          soundStartSec: null,
          sampleRate: info.audio?.sampleRate ?? null,
          channels: info.audio?.channels ?? null,
          hasAudio: Boolean(info.audio),
          ixml: null,
        },
      };
    }
    if (type === 'dng' || type === 'dpx' || type === 'exr') {
      // One frame of an image sequence (CinemaDNG, DPX, OpenEXR): the clip's timecode and rate are on it.
      const info = type === 'dng' ? await readDngInfo(file) : type === 'dpx' ? await readDpxInfo(file) : await readExrInfo(file);
      return {
        ok: true,
        meta: {
          kind: 'picture',
          format: type === 'dng' ? 'DNG' : type === 'dpx' ? 'DPX' : 'EXR',
          tc: info.timecode,
          ...(info.timecode ? { tcFrom: 'header' as const } : {}),
          rate: info.rate,
          durationSec: info.rate ? info.rate.den / info.rate.num : 0,
          soundStartSec: null,
          sampleRate: null,
          channels: null,
          hasAudio: false,
          ixml: null,
          sequence: true,
        },
      };
    }
    return { ok: false, error: `.${type} files are not read for timecode.` };
  } catch (cause) {
    return { ok: false, error: (cause as Error).message };
  } finally {
    await file.close();
  }
};

/** Audio from a media file as mono floats: a camera's scratch track from its start, or a stretch of a sound file. */
export const readMediaAudio = async (path: string, window: { startSec: number; seconds: number }): Promise<{ samples: Float32Array; sampleRate: number }> => {
  const type = extension(path);
  const file = await open(path, 'r');
  try {
    if (type === 'wav' || type === 'bwf') {
      const info = await readWavInfo(file);
      return { samples: await readWavSamples(file, info, window.startSec, window.seconds), sampleRate: info.sampleRate };
    }
    if (type === 'mov' || type === 'mp4' || type === 'm4v') {
      const info = await readQuickTimeInfo(file);
      if (!info.audio) throw new Error('No uncompressed scratch audio in this clip.');
      return { samples: await readQuickTimeAudio(file, info.audio, window.seconds), sampleRate: info.audio.sampleRate };
    }
    if (type === 'mxf') {
      const info = await readMxfInfo(file);
      if (!info.audio) throw new Error('No scratch audio in this clip.');
      return { samples: await readMxfAudio(file, info, window.seconds), sampleRate: info.audio.sampleRate };
    }
    throw new Error(`.${type} audio is not read.`);
  } finally {
    await file.close();
  }
};
