import { execFile } from 'node:child_process';
import { readdir, readFile, realpath, stat, statfs } from 'node:fs/promises';
import { basename } from 'node:path';
import type { VolumeRole } from '../../shared/media';

/**
 * Finding mounted cards and drives (spec §4.2): what is plugged in, its
 * size and free space, its filesystem, and what kind of media is on it.
 *
 * Neither macOS nor Windows offers Node a mount event, so the engine looks
 * every two seconds: a directory listing (macOS, Linux) or a free-space
 * query per drive letter (Windows), both cheap. Each newly seen volume is
 * described once with the system's own tool (diskutil, CIM).
 */

export interface Mount {
  path: string;
  name: string;
}

export interface Described {
  name: string;
  kind: string;
  filesystem: string;
}

export interface Capacity {
  totalBytes: number;
  freeBytes: number;
  /** Changes when a different disk is mounted at the same path. */
  device: number;
}

const run = (file: string, args: string[], timeout = 8000): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

export const capacityOf = async (path: string): Promise<Capacity | null> => {
  try {
    const [space, info] = await Promise.all([statfs(path), stat(path)]);
    return { totalBytes: space.blocks * space.bsize, freeBytes: space.bavail * space.bsize, device: info.dev };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- what is mounted

export const listMounts = async (platform: NodeJS.Platform = process.platform): Promise<Mount[]> => {
  if (platform === 'darwin') {
    const names = await readdir('/Volumes').catch(() => [] as string[]);
    const mounts: Mount[] = [];
    for (const name of names) {
      if (name.startsWith('.') || name.startsWith('com.apple.TimeMachine')) continue;
      const path = `/Volumes/${name}`;
      // The startup disk appears here as a link to "/": not a card, and never offered.
      if ((await realpath(path).catch(() => '/')) === '/') continue;
      mounts.push({ path, name });
    }
    return mounts;
  }
  if (platform === 'win32') {
    const system = (process.env['SystemDrive'] ?? 'C:').toUpperCase();
    const letters = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((letter) => `${letter}:` !== system);
    const found = await Promise.all(letters.map(async (letter) => ((await capacityOf(`${letter}:\\`)) ? letter : null)));
    return found.filter((letter): letter is string => letter !== null).map((letter) => ({ path: `${letter}:\\`, name: `${letter}:` }));
  }
  // Linux: removable media and manual mounts, for development and testing.
  const table = await readFile('/proc/self/mounts', 'utf8').catch(() => '');
  return table
    .split('\n')
    .map((line) => line.split(' ')[1]?.replace(/\\040/g, ' '))
    .filter((path): path is string => Boolean(path) && /^\/(media|run\/media|mnt)\/./.test(path!))
    .map((path) => ({ path, name: basename(path) }));
};

// ---------------------------------------------------------------- what it is

const plistValue = (plist: string, key: string): string | null => {
  const found = new RegExp(`<key>${key}</key>\\s*<(string|true|false)\\s*/?>([^<]*)`).exec(plist);
  if (!found) return null;
  return found[1] === 'string' ? found[2]! : found[1]!;
};

export const describeMount = async (mount: Mount, platform: NodeJS.Platform = process.platform): Promise<Described> => {
  try {
    if (platform === 'darwin') {
      const plist = await run('diskutil', ['info', '-plist', mount.path]);
      const protocol = plistValue(plist, 'BusProtocol') ?? '';
      const internal = plistValue(plist, 'Internal') === 'true';
      const kind = /secure digital|sd/i.test(protocol)
        ? 'SD card'
        : /usb/i.test(protocol)
          ? 'USB drive'
          : /thunderbolt|pci/i.test(protocol) && !internal
            ? 'Thunderbolt drive'
            : internal
              ? 'Internal drive'
              : 'Drive';
      return {
        name: plistValue(plist, 'VolumeName') || mount.name,
        kind,
        filesystem: plistValue(plist, 'FilesystemUserVisibleName') || plistValue(plist, 'FilesystemName') || '',
      };
    }
    if (platform === 'win32') {
      const letter = mount.path.slice(0, 2);
      const json = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}'" | Select-Object VolumeName,FileSystem,DriveType,ProviderName | ConvertTo-Json -Compress`,
      ]);
      const disk = JSON.parse(json) as { VolumeName?: string; FileSystem?: string; DriveType?: number; ProviderName?: string };
      const kind = disk.DriveType === 2 ? 'Removable drive' : disk.DriveType === 4 ? 'Network share' : disk.DriveType === 5 ? 'Optical disc' : 'Drive';
      return { name: disk.VolumeName || disk.ProviderName || letter, kind, filesystem: disk.FileSystem ?? '' };
    }
    const table = await readFile('/proc/self/mounts', 'utf8');
    const row = table.split('\n').find((line) => line.split(' ')[1]?.replace(/\\040/g, ' ') === mount.path);
    return { name: mount.name, kind: 'Drive', filesystem: row?.split(' ')[2] ?? '' };
  } catch {
    // A network share diskutil cannot describe, a slow PowerShell: the name and size still show.
    return { name: mount.name, kind: 'Drive', filesystem: '' };
  }
};

// ---------------------------------------------------------------- what is on it

export interface Classified {
  detected: string;
  role: VolumeRole;
}

/** ARRI's clip naming: A001C002_220101_R1AB. */
const ARRI_CLIP = /^[A-Z]\d{3}C\d{3}_\d{6}_[A-Z0-9]{4}/i;
const VIDEO = new Set(['mov', 'mp4', 'mxf', 'ari', 'arx', 'r3d', 'braw', 'crm', 'mts', 'm2ts', 'dng', 'avi']);
const SOUND = new Set(['wav', 'bwf', 'aif', 'aiff']);

/**
 * A look at the first few thousand entries, to say what the volume holds
 * and suggest its role. A suggestion only: the operator decides, and a
 * volume that is neither recognisably a card nor a VC DIT drive is "Other",
 * which is never read from or written to until someone says so.
 */
export const classifyVolume = async (root: string, limit = 4000): Promise<Classified> => {
  const extensions = new Map<string, number>();
  const folders = new Set<string>();
  let arriNames = 0;
  let files = 0;
  let seen = 0;
  let ours = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (seen >= limit || depth > 5) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= limit) return;
      seen += 1;
      if (entry.name.startsWith('.') || entry.name === 'System Volume Information' || entry.name === '$RECYCLE.BIN') continue;
      if (entry.isDirectory()) {
        folders.add(entry.name.toUpperCase());
        if (/^SHOOT_DAY_\d+/.test(entry.name)) ours = true;
        await walk(`${dir}/${entry.name}`, depth + 1);
      } else if (entry.isFile()) {
        files += 1;
        const extension = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : '';
        extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
        if (ARRI_CLIP.test(entry.name)) arriNames += 1;
      }
    }
  };
  await walk(root, 0);

  const count = (...names: string[]) => names.reduce((sum, name) => sum + (extensions.get(name) ?? 0), 0);
  const video = [...extensions].filter(([extension]) => VIDEO.has(extension)).reduce((sum, [, n]) => sum + n, 0);
  const sound = [...extensions].filter(([extension]) => SOUND.has(extension)).reduce((sum, [, n]) => sum + n, 0);

  if (ours) return { detected: 'VC DIT media drive', role: 'Destination' };
  if (count('ari', 'arx')) return { detected: 'ARRI · ARRIRAW', role: 'Camera' };
  if (count('r3d')) return { detected: 'RED · R3D', role: 'Camera' };
  if (count('braw')) return { detected: 'Blackmagic · BRAW', role: 'Camera' };
  if (count('crm')) return { detected: 'Canon · Cinema RAW Light', role: 'Camera' };
  if (folders.has('XDROOT') || folders.has('M4ROOT')) return { detected: count('mxf') ? 'Sony · X-OCN / XAVC' : 'Sony', role: 'Camera' };
  if (count('mxf') && arriNames) return { detected: 'ARRI · MXF', role: 'Camera' };
  if (count('mov') && arriNames) return { detected: 'ARRI · ProRes', role: 'Camera' };
  if (folders.has('CONTENTS') && folders.has('CLIPS001')) return { detected: 'Canon', role: 'Camera' };
  if (video && folders.has('DCIM')) return { detected: `Camera · ${video} clips`, role: 'Camera' };
  if (count('mxf')) return { detected: `Camera · ${count('mxf')} MXF`, role: 'Camera' };
  if (sound && !video) return { detected: `Sound · ${sound} WAV`, role: 'Sound' };
  if (files === 0) return { detected: 'Empty volume', role: 'Other' };
  return { detected: video ? `${video} video files` : 'Other files', role: 'Other' };
};
