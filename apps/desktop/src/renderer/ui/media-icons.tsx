import { useEffect, useState } from 'react';
import type { DeviceInfo } from '../../shared/media';
import type { IconSize } from '../state/store';
import { BRAND_NAME, type Brand } from '../../shared/brands';

/** Pixel sizes for each preference (Preferences → Icon size): a source or destination tile, a transfer row, a list line. */
export const ICON_PX: Record<IconSize, { tile: number; row: number; list: number }> = {
  small: { tile: 48, row: 28, list: 22 },
  medium: { tile: 72, row: 40, list: 28 },
  large: { tile: 104, row: 56, list: 36 },
};

/**
 * What a source or destination is, at a glance (as offload tools show it):
 * a camera card (CFexpress, a RED mag, AXS, a Codex drive, CFast, SD), a
 * sound card, an SSD, a hard drive, a RAID, a shuttle, an archive, a
 * network share, a folder, or a cloud-synced folder. The kind comes from
 * what the system says about the device (its model, bus, solid state,
 * RAID) and what is on it.
 *
 * Drives and folders show the system's own icon where the app has one
 * (Explorer's on Windows, Finder's on macOS), so they look as they do
 * everywhere else on that computer. Camera media, RAIDs and archives,
 * which the system draws as plain drives, are drawn here. Camera cards
 * carry their maker's badge (see BrandBadge).
 */

export type MediaKind =
  | 'card'
  | 'redmag'
  | 'axs'
  | 'codex'
  | 'cfast'
  | 'sd'
  | 'sound'
  | 'internal'
  | 'ssd'
  | 'hdd'
  | 'external'
  | 'raid'
  | 'shuttle'
  | 'archive'
  | 'nas'
  | 'folder'
  | 'cloud';

export interface MediaLook {
  kind: MediaKind;
  /** "LucidLink", "Dropbox"…: for a cloud-synced folder. */
  service: string | null;
}

const SERVICES: [RegExp, string][] = [
  [/lucid/i, 'LucidLink'],
  [/dropbox/i, 'Dropbox'],
  [/google ?drive|googledrive|my drive/i, 'Google Drive'],
  [/onedrive/i, 'OneDrive'],
  [/\bbox\b|box-box/i, 'Box'],
  [/icloud|mobile documents/i, 'iCloud Drive'],
  [/frame\.?io/i, 'Frame.io'],
  [/suite ?studios|\bsuite\b/i, 'Suite'],
];

/** The service a synced folder belongs to, from its path, name or filesystem. */
export const serviceOf = (...hints: (string | null | undefined)[]): string | null => {
  const text = hints.filter(Boolean).join(' ');
  return SERVICES.find(([pattern]) => pattern.test(text))?.[1] ?? null;
};

/** Makers' RAID enclosures and RAID software, by model name. */
const RAID_MODEL = /raid|thunderbay|pegasus|2big|4big|6big|8big|12big|softraid|areca|accusys|sonnet fusion|terramaster d\d|qnap|synology|drobo|g-speed|g-raid|promise|owc express 4m2|storage space/i;
/** Solid-state drives that do not say so: by model. */
const SSD_MODEL = /ssd|nvme|m\.2|\bt[579]\b|portable ssd|extreme pro|sandisk extreme|crucial x\d|envoy|atomos|angelbird|ssd7|glyph atom|lacie rugged ssd/i;

/** Which camera medium a card is, from its model and bus. */
const cardKind = (hints: string, bus: string | null | undefined): MediaKind => {
  if (/red\s*(mini-?)?mag|redmag|red mag/i.test(hints)) return 'redmag';
  if (/\baxs\b/i.test(hints)) return 'axs';
  if (/codex|compact drive/i.test(hints)) return 'codex';
  if (/cfast/i.test(hints)) return 'cfast';
  if (/^(sd|mmc|secure digital)/i.test(bus ?? '') || /\bsd\b|sd card|sdxc|sdhc|microsd/i.test(hints)) return 'sd';
  return 'card';
};

/** A mounted volume: from what the system says the device is, its role, its name and filesystem. */
export const volumeLook = (volume: { role: string; media: string; name: string; filesystem: string; detected?: string; device?: DeviceInfo }): MediaLook => {
  const device = volume.media.split(' · ')[0] ?? '';
  const model = volume.device?.model ?? '';
  const hints = `${model} ${device}`;
  const service = serviceOf(volume.name, volume.filesystem, model);
  if (service) return { kind: 'cloud', service };
  if (volume.role === 'Sound') return { kind: 'sound', service: null };
  if (volume.role === 'Camera') return { kind: cardKind(hints, volume.device?.bus), service: null };
  if (/network|smb|nfs|afp|webdav/i.test(`${device} ${volume.filesystem} ${volume.device?.bus ?? ''}`)) return { kind: 'nas', service: null };
  if (volume.role === 'Archive' && /lto|tape|ltfs/i.test(`${hints} ${volume.name} ${volume.filesystem}`)) return { kind: 'archive', service: null };
  if (volume.device?.raid || RAID_MODEL.test(`${hints} ${volume.name}`)) return { kind: 'raid', service: null };
  if (volume.role === 'Shuttle') return { kind: 'shuttle', service: null };
  if (/internal/i.test(device)) return { kind: 'internal', service: null };
  // A camera medium in a reader, used as a destination: still drawn as what it is.
  const media = cardKind(hints, volume.device?.bus);
  if (media !== 'card' || /cfexpress|xqd/i.test(hints)) return { kind: media, service: null };
  if (volume.device?.solidState === true || SSD_MODEL.test(hints)) return { kind: 'ssd', service: null };
  if (volume.device?.solidState === false) return { kind: 'hdd', service: null };
  return { kind: 'external', service: null };
};

/** A folder picked as a destination: by where it is. */
export const folderLook = (folder: { name: string; kind: string }): MediaLook => {
  const service = serviceOf(folder.kind, folder.name);
  if (service) return { kind: 'cloud', service };
  if (/^\\\\|smb:|nfs:|afp:|\bnas\b|network|10gbe/i.test(`${folder.kind} ${folder.name}`)) return { kind: 'nas', service: null };
  if (/raid/i.test(`${folder.kind} ${folder.name}`)) return { kind: 'raid', service: null };
  if (/shuttle/i.test(folder.kind)) return { kind: 'shuttle', service: null };
  return { kind: 'folder', service: null };
};

export const KIND_WORD: Record<MediaKind, string> = {
  card: 'CFexpress card',
  redmag: 'RED mag',
  axs: 'AXS card',
  codex: 'Codex drive',
  cfast: 'CFast card',
  sd: 'SD card',
  sound: 'Sound card',
  internal: 'Internal drive',
  ssd: 'SSD',
  hdd: 'Hard drive',
  external: 'Drive',
  raid: 'RAID',
  shuttle: 'Shuttle drive',
  archive: 'Archive',
  nas: 'Network storage',
  folder: 'Folder',
  cloud: 'Cloud folder',
};

/** Kinds the system draws as well as anyone: plain drives, shares and folders. Its own icon is used for these where there is one. */
const SYSTEM_KINDS = new Set<MediaKind>(['internal', 'ssd', 'hdd', 'external', 'shuttle', 'nas', 'folder', 'cloud']);

const systemIcons = new Map<string, Promise<string | null>>();
/** The system's icon for a drive or folder (desktop app only), once it has been asked for. */
export const useSystemIcon = (path: string | undefined, kind: MediaKind): string | null => {
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    const media = typeof window === 'undefined' ? undefined : window.vcdit?.media;
    if (!path || !SYSTEM_KINDS.has(kind) || !media?.icon) {
      setIcon(null);
      return undefined;
    }
    let live = true;
    if (!systemIcons.has(path)) systemIcons.set(path, media.icon(path).catch(() => null));
    void systemIcons.get(path)!.then((found) => live && setIcon(found));
    return () => {
      live = false;
    };
  }, [path, kind]);
  return icon;
};

/** Tests: forget the system icons asked for. */
export const forgetSystemIcons = () => systemIcons.clear();

/**
 * A source or destination's picture: the system's own icon for a drive or
 * folder when the desktop app has one, else the drawn one; a camera card
 * with its maker's badge.
 */
export function DeviceIcon({ look, size = 64, path, brand }: { look: MediaLook; size?: number; path?: string; brand?: string | null }) {
  const system = useSystemIcon(path, look.kind);
  return (
    <span className="device-icon" style={{ width: size, height: size }}>
      {system ? <img src={system} width={size} height={size} alt="" className="device-icon-system" draggable={false} /> : <MediaIcon look={look} size={size} />}
      {brand ? <BrandBadge brand={brand} size={size} /> : null}
    </span>
  );
}

// ---------------------------------------------------------------- camera makers

export { BRAND_NAME, brandOf, type Brand } from '../../shared/brands';

/**
 * The maker's logo files, where the production has put them in
 * src/renderer/assets/brands (arri.svg, red.svg, sony.svg…; see the README
 * there). Without one, the maker's name is set as a small badge.
 */
const BRAND_FILES = import.meta.glob('../assets/brands/*.{svg,png}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const brandFile = (brand: Brand): string | null =>
  Object.entries(BRAND_FILES).find(([path]) => path.split('/').pop()!.replace(/\.(svg|png)$/, '') === brand)?.[1] ?? null;

export function BrandBadge({ brand, size = 64 }: { brand: string; size?: number }) {
  const known = (Object.keys(BRAND_NAME) as Brand[]).includes(brand as Brand) ? (brand as Brand) : null;
  const file = known ? brandFile(known) : null;
  const name = known ? BRAND_NAME[known] : brand;
  const height = Math.max(12, Math.round(size * 0.24));
  return (
    <span className={`brand-badge brand-${known ?? 'other'}`} title={name} style={{ height, fontSize: Math.round(height * 0.62) }}>
      {file ? <img src={file} alt={name} style={{ height: Math.round(height * 0.7) }} /> : name}
    </span>
  );
}

/** The picture. Colour comes from `currentColor` and the --icon-* tokens, so it follows the theme. */
export function MediaIcon({ look, size = 64 }: { look: MediaLook; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': true as const, className: `media-icon media-${look.kind}` };
  switch (look.kind) {
    case 'redmag':
      return (
        <svg {...common}>
          <rect x="8" y="16" width="48" height="32" rx="3" className="mi-body" />
          <path d="M8 22h48" className="mi-line" />
          <rect x="14" y="27" width="26" height="14" rx="2" className="mi-label" />
          <text x="27" y="37" textAnchor="middle" className="mi-text">
            MAG
          </text>
          <path d="M46 29v10M50 29v10" className="mi-line" />
        </svg>
      );
    case 'axs':
      return (
        <svg {...common}>
          <rect x="12" y="10" width="40" height="44" rx="3" className="mi-body" />
          <path d="M12 18h40" className="mi-line" />
          <rect x="18" y="24" width="28" height="18" rx="2" className="mi-label" />
          <text x="32" y="36" textAnchor="middle" className="mi-text">
            AXS
          </text>
          <path d="M20 48h24" className="mi-line" />
        </svg>
      );
    case 'codex':
      return (
        <svg {...common}>
          <rect x="10" y="12" width="44" height="40" rx="5" className="mi-body" />
          <rect x="16" y="20" width="32" height="16" rx="2" className="mi-label" />
          <text x="32" y="31" textAnchor="middle" className="mi-text">
            CODEX
          </text>
          <path d="M18 44h20" className="mi-line" />
          <circle cx="45" cy="44" r="1.8" className="mi-led" />
        </svg>
      );
    case 'cfast':
      return (
        <svg {...common}>
          <rect x="12" y="8" width="40" height="48" rx="3" className="mi-body" />
          <rect x="18" y="14" width="28" height="18" rx="2" className="mi-label" />
          <text x="32" y="26" textAnchor="middle" className="mi-text">
            CFAST
          </text>
          <path d="M18 48h28" className="mi-line" />
        </svg>
      );
    case 'ssd':
      return (
        <svg {...common}>
          <rect x="14" y="8" width="36" height="48" rx="6" className="mi-body" />
          <rect x="20" y="16" width="24" height="22" rx="3" className="mi-label" />
          <text x="32" y="30" textAnchor="middle" className="mi-text">
            SSD
          </text>
          <circle cx="32" cy="47" r="1.8" className="mi-led" />
        </svg>
      );
    case 'hdd':
      return (
        <svg {...common}>
          <rect x="10" y="10" width="44" height="44" rx="6" className="mi-body" />
          <circle cx="30" cy="30" r="13" className="mi-label" />
          <circle cx="30" cy="30" r="3" className="mi-line" />
          <path d="M46 20l-10 9" className="mi-line" />
          <circle cx="46" cy="47" r="1.8" className="mi-led" />
        </svg>
      );
    case 'card':
      return (
        <svg {...common}>
          <rect x="14" y="8" width="36" height="48" rx="4" className="mi-body" />
          <rect x="20" y="14" width="24" height="16" rx="2" className="mi-label" />
          <path d="M20 46h4M27 46h4M34 46h4M41 46h3" className="mi-line" />
          <text x="32" y="25" textAnchor="middle" className="mi-text">
            CFE
          </text>
        </svg>
      );
    case 'sd':
      return (
        <svg {...common}>
          <path d="M18 8h22l10 10v34a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4Z" className="mi-body" />
          <path d="M22 8v9M28 8v9M34 8v9" className="mi-line" />
          <rect x="20" y="26" width="24" height="20" rx="2" className="mi-label" />
        </svg>
      );
    case 'sound':
      return (
        <svg {...common}>
          <path d="M18 8h22l10 10v34a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4Z" className="mi-body" />
          <rect x="19" y="24" width="26" height="22" rx="2" className="mi-label" />
          <path d="M23 35v0M26 31v8M29 28v14M32 32v6M35 29v12M38 33v4M41 35v0" className="mi-wave" />
        </svg>
      );
    case 'internal':
      return (
        <svg {...common}>
          <rect x="8" y="14" width="48" height="38" rx="5" className="mi-body" />
          <circle cx="30" cy="32" r="12" className="mi-label" />
          <circle cx="30" cy="32" r="3" className="mi-line" />
          <path d="M44 22l-10 8" className="mi-line" />
          <path d="M14 46h36" className="mi-line" />
        </svg>
      );
    case 'external':
      return (
        <svg {...common}>
          <rect x="12" y="10" width="40" height="44" rx="7" className="mi-body" />
          <rect x="18" y="16" width="28" height="26" rx="3" className="mi-label" />
          <circle cx="44" cy="48" r="1.8" className="mi-led" />
          <path d="M22 48h12" className="mi-line" />
        </svg>
      );
    case 'raid':
      return (
        <svg {...common}>
          <rect x="10" y="8" width="44" height="48" rx="4" className="mi-body" />
          {[14, 24, 34, 44].map((y) => (
            <g key={y}>
              <rect x="15" y={y} width="34" height="7" rx="1.5" className="mi-label" />
              <circle cx="44" cy={y + 3.5} r="1.3" className="mi-led" />
            </g>
          ))}
        </svg>
      );
    case 'shuttle':
      return (
        <svg {...common}>
          <path d="M22 14v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4" className="mi-line" />
          <rect x="10" y="14" width="44" height="42" rx="8" className="mi-body" />
          <rect x="17" y="22" width="30" height="20" rx="3" className="mi-label" />
          <path d="M18 49h28" className="mi-line" />
          <circle cx="47" cy="49" r="1.6" className="mi-led" />
        </svg>
      );
    case 'archive':
      return (
        <svg {...common}>
          <rect x="8" y="14" width="48" height="36" rx="3" className="mi-body" />
          <rect x="14" y="20" width="22" height="14" rx="2" className="mi-label" />
          <circle cx="45" cy="27" r="5" className="mi-line" />
          <path d="M14 42h36" className="mi-line" />
          <text x="25" y="30" textAnchor="middle" className="mi-text">
            LTO
          </text>
        </svg>
      );
    case 'nas':
      return (
        <svg {...common}>
          <rect x="12" y="8" width="40" height="36" rx="4" className="mi-body" />
          {[14, 23, 32].map((y) => (
            <g key={y}>
              <path d={`M18 ${y + 3}h20`} className="mi-line" />
              <circle cx="45" cy={y + 3} r="1.4" className="mi-led" />
            </g>
          ))}
          <path d="M32 44v6M16 54h32M32 50v4" className="mi-line" />
        </svg>
      );
    case 'cloud':
      return (
        <svg {...common}>
          <path d="M20 46h26a10 10 0 0 0 1-19.9A14 14 0 0 0 20 23a11.5 11.5 0 0 0 0 23Z" className="mi-body" />
          <path d="M32 40V28M27 33l5-5 5 5" className="mi-line" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M8 18a4 4 0 0 1 4-4h12l5 6h23a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4Z" className="mi-folder" />
          <path d="M8 26h48" className="mi-folder-lip" />
        </svg>
      );
  }
}
