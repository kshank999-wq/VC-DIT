import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * FFmpeg, run as its own program for the Looks preview and dailies. The
 * packaged app carries it in Resources/ffmpeg/<platform>-<arch>/ (fetched and
 * checked by scripts/fetch-ffmpeg.mjs); a developer's copy can be named with
 * VCDIT_FFMPEG or found on the PATH.
 */

export interface Ffmpeg {
  path: string;
  version: string;
  encoders: Set<string>;
  filters: Set<string>;
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

/** The second column of `-encoders` / `-filters` listings: the names. */
const names = (listing: string) =>
  new Set(
    listing
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((name): name is string => Boolean(name && /^[\w-]+$/.test(name))),
  );

export const locateFfmpeg = async (resources: string | null): Promise<Ffmpeg | null> => {
  const binary = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    process.env['VCDIT_FFMPEG'],
    resources ? join(resources, 'ffmpeg', `${process.platform}-${process.arch}`, binary) : null,
    'ffmpeg',
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const path of candidates) {
    try {
      if (path !== 'ffmpeg') await access(path);
      const version = (await run(path, ['-hide_banner', '-version'])).split('\n')[0] ?? '';
      const [encoders, filters] = await Promise.all([run(path, ['-hide_banner', '-encoders']), run(path, ['-hide_banner', '-filters'])]);
      return { path, version: version.replace(/^ffmpeg version\s*/, '').split(' ')[0] ?? version, encoders: names(encoders), filters: names(filters) };
    } catch {
      // Not this one.
    }
  }
  return null;
};

export interface RunResult {
  code: number | null;
  /** The last lines FFmpeg wrote, for saying what went wrong. */
  log: string;
  stopped: boolean;
}

/** Run FFmpeg; `onTime` hears how many seconds of output are done (from -progress). */
export const runFfmpeg = (
  ffmpeg: Ffmpeg,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; onTime?: (seconds: number) => void } = {},
): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = spawn(ffmpeg.path, ['-hide_banner', '-nostdin', '-progress', 'pipe:1', '-nostats', ...args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    let pending = '';
    let stopped = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const found = /^out_time_us=(\d+)/.exec(line) ?? /^out_time_ms=(\d+)/.exec(line);
        if (found) options.onTime?.(Number(found[1]) / 1e6);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      log = (log + chunk).slice(-4000);
    });
    const stop = () => {
      stopped = true;
      child.kill();
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (error) => resolve({ code: null, log: error.message, stopped }));
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', stop);
      resolve({ code, log: log.trim().split('\n').slice(-6).join('\n'), stopped });
    });
  });
