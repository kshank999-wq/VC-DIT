import { app } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * This installation, for its license seat (VC Writer's approach). A seat is a
 * place the app is installed, not a piece of hardware: a random salt made on
 * first run and kept in the app's data, hashed with the machine's name. Stable
 * across restarts and reinstalls that keep app data; no hardware serial or MAC
 * address goes into it.
 */

const saltPath = () => join(app.getPath('userData'), 'device-salt');
let cached: string | null = null;

export const deviceFingerprint = async (): Promise<string> => {
  if (cached) return cached;
  let salt = '';
  try {
    salt = (await readFile(saltPath(), 'utf8')).trim();
  } catch {
    // First run.
  }
  if (salt.length < 32) {
    salt = randomBytes(32).toString('hex');
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(saltPath(), salt, 'utf8');
  }
  cached = createHash('sha256').update(`${salt}:${hostname()}`).digest('hex');
  return cached;
};

/** A name the owner will recognise on their account page. */
export const deviceName = (): string => {
  const machine = hostname().replace(/\.local$/i, '');
  try {
    const user = userInfo().username;
    return user && !machine.toLowerCase().includes(user.toLowerCase()) ? `${machine} (${user})` : machine;
  } catch {
    return machine;
  }
};

export const devicePlatform = (): 'windows' | 'macos' | null =>
  process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos'
      : // Only an unpackaged run (development, the end-to-end check on Linux) may stand in for a Mac.
        !app.isPackaged && process.env['VCDIT_DEVICE_PLATFORM'] === 'macos'
        ? 'macos'
        : null;
