import { open } from 'node:fs/promises';
import { readMxfAudio, readMxfInfo } from './mxf';
import { readQuickTimeAudio, readQuickTimeInfo } from './quicktime';
import { readWavInfo, readWavSamples } from './wav';

/**
 * What VC DIT reads from a media file's header (spec "Clip / Audio File":
 * timecode, metadata): enough to sync picture and sound and to show start
 * timecode and length. Formats whose timecode lives in a vendor SDK (R3D,
 * BRAW, ARRIRAW .ari, Canon RAW) say so instead of guessing.
 */

export interface MediaMeta {
  kind: 'picture' | 'sound';
  format: 'QuickTime' | 'MXF' | 'WAV';
  /** Picture: the first frame's timecode as a frame count at its timebase. */
  tc: { frames: number; base: number; dropFrame: boolean } | null;
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
const NO_READER: Record<string, string> = {
  r3d: 'RED R3D timecode needs the RED SDK; sync these by waveform from a proxy, or manually.',
  braw: 'Blackmagic RAW timecode needs the Blackmagic SDK; sync these manually for now.',
  ari: 'ARRIRAW (.ari) frames are not read yet; sync these manually for now.',
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
      return {
        ok: true,
        meta: {
          kind: 'picture',
          format: 'QuickTime',
          tc: info.timecode,
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
      return {
        ok: true,
        meta: {
          kind: 'picture',
          format: 'MXF',
          tc: info.timecode,
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
