import type { Ffmpeg } from '../ffmpeg/ffmpeg';

/**
 * One take's daily as an FFmpeg command (spec §4.8): the clip through its
 * viewing look, scaled (and letterboxed) to the chosen size, with burn-ins,
 * and the production sound laid in by its sync. The camera original is only
 * read. Text and the LUT are files in the job's own folder (the working
 * directory), so no path or note ever has to be escaped into a filter.
 */

export interface DailiesChoice {
  codec: string;
  resolution: string;
  audio: string;
  burnIns: Record<string, boolean>;
}

export interface RenderJob {
  /** "14B-03". */
  label: string;
  clip: string;
  clipPath: string;
  rate: { num: number; den: number };
  durationSec: number;
  /** The clip's first frame as a timecode frame count, and its timebase. */
  tc: { frames: number; base: number; dropFrame?: boolean } | null;
  clipHasAudio: boolean;
  /** The synced sound file: where it starts relative to the clip, in frames, and its channels. */
  sound: { path: string; alignFrames: number; channels: number } | null;
  /** The look: written into the job folder as `look.<ext>`. */
  look: { name: string; extension: 'cube' | '3dl' } | null;
  circle: boolean;
  notes: string;
  production: string;
  choice: DailiesChoice;
  /** The burn-in font, copied into the job folder as `font.ttf`, or null when there is none. */
  font: boolean;
}

export interface RenderCommand {
  args: string[];
  /** Small text files the command reads from the job folder. */
  files: Record<string, string>;
  /** The output's real extension and FFmpeg format. */
  extension: 'mov' | 'mp4';
  format: 'mov' | 'mp4';
  /** What could not be done as asked, said plainly. */
  warnings: string[];
}

export { DAILIES_AUDIO as AUDIO, DAILIES_CODECS as CODECS, DAILIES_RESOLUTIONS as RESOLUTIONS } from '../../shared/project';

/**
 * A frame count as a timecode label. Drop-frame (29.97 and 59.94 DF) skips
 * frame numbers 00 and 01 (00–03 at 59.94) at the start of each minute
 * except every tenth, so the label keeps to the clock; it is written with a
 * semicolon before the frames, as editors expect.
 */
export const timecodeLabel = (frames: number, base: number, dropFrame = false): string => {
  let count = Math.max(0, Math.round(frames));
  const drop = dropFrame && base % 30 === 0 ? (base / 30) * 2 : 0;
  if (drop) {
    const perTenMinutes = base * 600 - drop * 9;
    const perMinute = base * 60 - drop;
    const tens = Math.floor(count / perTenMinutes);
    const rest = count % perTenMinutes;
    count += drop * 9 * tens + (rest > drop ? drop * Math.floor((rest - drop) / perMinute) : 0);
  }
  const ff = count % base;
  const total = Math.floor(count / base);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}${drop ? ';' : ':'}${pad(ff)}`;
};

const size = (resolution: string) => {
  const found = /(\d+)\s*×\s*(\d+)/.exec(resolution);
  const width = Number(found?.[1] ?? 1920);
  const height = Number(found?.[2] ?? 1080);
  return { width, height, letterbox: /letterbox/i.test(resolution) };
};

const videoCodec = (codec: string, ffmpeg: Pick<Ffmpeg, 'encoders'>): { args: string[]; pixel: string; audio: string[]; extension: 'mov' | 'mp4' } => {
  if (codec.startsWith('ProRes')) {
    return {
      args: ['-c:v', 'prores_ks', '-profile:v', codec.includes('LT') ? '1' : '0', '-vendor', 'apl0'],
      pixel: 'yuv422p10le',
      audio: ['-c:a', 'pcm_s24le'],
      extension: 'mov',
    };
  }
  if (codec.startsWith('DNx')) return { args: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb'], pixel: 'yuv422p', audio: ['-c:a', 'pcm_s24le'], extension: 'mov' };
  const h264 = ['libx264', 'h264_videotoolbox', 'h264_mf'].find((name) => ffmpeg.encoders.has(name));
  if (!h264) throw new Error('This FFmpeg has no H.264 encoder. Choose ProRes or DNxHR.');
  const rate = ['-b:v', '10M', '-maxrate', '12M', '-bufsize', '20M'];
  return {
    args: ['-c:v', h264, ...(h264 === 'libx264' ? ['-preset', 'medium'] : []), ...rate, '-movflags', '+faststart'],
    pixel: 'yuv420p',
    audio: ['-c:a', 'aac', '-b:a', '256k'],
    extension: 'mp4',
  };
};

export const renderArgs = (job: RenderJob, ffmpeg: Pick<Ffmpeg, 'encoders' | 'filters'>): RenderCommand => {
  const warnings: string[] = [];
  const files: Record<string, string> = {};
  const { width, height, letterbox } = size(job.choice.resolution);
  const codec = videoCodec(job.choice.codec, ffmpeg);
  const fps = job.rate.num / job.rate.den;
  const args: string[] = ['-y', '-i', job.clipPath];

  // ------------------------------------------------ picture
  const video: string[] = [];
  if (job.look) {
    if (ffmpeg.filters.has('lut3d')) video.push(`lut3d=file=look.${job.look.extension}:interp=tetrahedral`);
    else warnings.push('This FFmpeg cannot apply LUTs; the daily is the LOG original.');
  }
  video.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`, 'setsar=1');
  if (letterbox) {
    const bar = Math.max(0, Math.round((height - width / 2.39) / 2));
    if (bar > 0) video.push(`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`, `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`);
  }
  const burn = job.choice.burnIns;
  const wantsText = Object.entries(burn).some(([key, on]) => on && key !== 'Watermark') || burn['Watermark'];
  if (wantsText && (!job.font || !ffmpeg.filters.has('drawtext'))) {
    warnings.push(job.font ? 'This FFmpeg cannot draw text; no burn-ins.' : 'No burn-in font found; no burn-ins.');
  } else if (wantsText) {
    const fontSize = Math.round(height / 30);
    const margin = Math.round(height / 40);
    const box = 'box=1:boxcolor=black@0.55:boxborderw=6';
    const text = (name: string, value: string, position: string, extra = '') => {
      files[`${name}.txt`] = value;
      video.push(`drawtext=fontfile=font.ttf:textfile=${name}.txt:expansion=none:fontsize=${fontSize}:fontcolor=white:${box}:${position}${extra}`);
    };
    if (burn['Scene/Take']) text('slate', `${job.label}${job.circle && burn['Circle'] ? '  CIRCLE' : ''}`, `x=${margin}:y=${margin}`);
    else if (burn['Circle'] && job.circle) text('slate', 'CIRCLE', `x=${margin}:y=${margin}`);
    if (burn['Clip name']) text('clip', job.clip, `x=w-tw-${margin}:y=${margin}`);
    if (burn['Look']) text('look', job.look ? job.look.name.replace(/\.(cube|3dl)$/i, '') : 'LOG · no look', `x=w-tw-${margin}:y=h-th-${margin}`);
    if (burn['Notes'] && job.notes) text('notes', job.notes.slice(0, 120), `x=(w-tw)/2:y=h-th-${margin * 3}`);
    if (burn['Watermark']) text('watermark', `${job.production} · CONFIDENTIAL`, 'x=(w-tw)/2:y=(h-th)/2', ':alpha=0.25');
    if (burn['TC'] && job.tc) {
      // The clip's own timecode, counting with the picture.
      const label = timecodeLabel(job.tc.frames, job.tc.base, job.tc.dropFrame).replace(/[:;]/g, (mark) => `\\${mark}`);
      video.push(`drawtext=fontfile=font.ttf:timecode='${label}':rate=${job.rate.num}/${job.rate.den}:fontsize=${fontSize}:fontcolor=white:${box}:x=${margin}:y=h-th-${margin}`);
    } else if (burn['TC']) warnings.push('No timecode in this clip to burn in.');
  }
  video.push(`format=${codec.pixel}`);

  // ------------------------------------------------ sound
  let audio: string | null = null;
  const synced = job.choice.audio.startsWith('Synced');
  if (synced && job.sound) {
    const offset = job.sound.alignFrames / fps;
    // The sound file started before the clip: skip into it. After: wait for it.
    if (offset < 0) args.push('-ss', (-offset).toFixed(4));
    args.push('-i', job.sound.path);
    const channels = Math.max(1, job.sound.channels);
    const mixAll = job.choice.audio.includes('all') && channels > 1;
    const sum = mixAll ? Array.from({ length: channels }, (_, c) => `${(1 / channels).toFixed(4)}*c${c}`).join('+') : 'c0';
    audio = `[1:a]${offset > 0 ? `adelay=${Math.round(offset * 1000)}:all=1,` : ''}pan=stereo|c0=${sum}|c1=${sum},aresample=48000[a]`;
  } else if (job.choice.audio !== 'No audio') {
    if (synced) warnings.push('No synced sound for this take; the camera scratch audio is used.');
    if (job.clipHasAudio) audio = '[0:a:0]aresample=48000[a]';
    else warnings.push('No audio in this clip.');
  }

  const graph = [`[0:v:0]${video.join(',')}[v]`, ...(audio ? [audio] : [])].join(';');
  args.push('-filter_complex', graph, '-map', '[v]');
  if (audio) args.push('-map', '[a]', ...codec.audio);
  else args.push('-an');
  args.push(...codec.args, '-r', `${job.rate.num}/${job.rate.den}`, '-t', job.durationSec.toFixed(4));
  if (job.tc) args.push('-timecode', timecodeLabel(job.tc.frames, job.tc.base, job.tc.dropFrame));
  // The look travels in the file's metadata (spec §4.7).
  args.push('-metadata', `comment=VC DIT daily · ${job.label} · ${job.clip} · look: ${job.look?.name ?? 'none (LOG)'}`);
  args.push('-f', codec.extension);
  return { args, files, extension: codec.extension, format: codec.extension, warnings };
};
