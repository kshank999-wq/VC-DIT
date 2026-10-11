/**
 * What a source or destination is, at a glance (as offload tools show it):
 * a camera card, a sound card, a drive, a RAID, a shuttle, an archive, a
 * network share, a folder, or a cloud-synced folder. Drawn here, in the
 * app's own line style; cloud services show as a cloud with the service's
 * name rather than its trademarked logo.
 */

export type MediaKind =
  | 'card'
  | 'sd'
  | 'sound'
  | 'internal'
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

/** A mounted volume: from its role, what kind of device it is ("SD card", "Network share"…), its name and filesystem. */
export const volumeLook = (volume: { role: string; media: string; name: string; filesystem: string; detected?: string }): MediaLook => {
  const device = volume.media.split(' · ')[0] ?? '';
  const service = serviceOf(volume.name, volume.filesystem);
  if (service) return { kind: 'cloud', service };
  if (volume.role === 'Sound') return { kind: 'sound', service: null };
  if (volume.role === 'Camera') return { kind: /\bsd\b|sd card/i.test(device) ? 'sd' : 'card', service: null };
  if (/network|smb|nfs|afp/i.test(`${device} ${volume.filesystem}`)) return { kind: 'nas', service: null };
  if (volume.role === 'Shuttle') return { kind: 'shuttle', service: null };
  if (volume.role === 'Archive') return { kind: /lto|tape/i.test(`${device} ${volume.name}`) ? 'archive' : 'nas', service: null };
  if (/internal/i.test(device)) return { kind: 'internal', service: null };
  if (/raid/i.test(`${volume.name} ${device}`)) return { kind: 'raid', service: null };
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
  card: 'Camera card',
  sd: 'SD card',
  sound: 'Sound card',
  internal: 'Internal drive',
  external: 'Drive',
  raid: 'RAID',
  shuttle: 'Shuttle drive',
  archive: 'Archive',
  nas: 'Network storage',
  folder: 'Folder',
  cloud: 'Cloud folder',
};

/** The picture. Colour comes from `currentColor` and the --icon-* tokens, so it follows the theme. */
export function MediaIcon({ look, size = 64 }: { look: MediaLook; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': true as const, className: `media-icon media-${look.kind}` };
  switch (look.kind) {
    case 'card':
      return (
        <svg {...common}>
          <rect x="14" y="8" width="36" height="48" rx="4" className="mi-body" />
          <rect x="20" y="14" width="24" height="16" rx="2" className="mi-label" />
          <path d="M20 46h4M27 46h4M34 46h4M41 46h3" className="mi-line" />
          <path d="M22 20h14M22 25h9" className="mi-line" />
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
