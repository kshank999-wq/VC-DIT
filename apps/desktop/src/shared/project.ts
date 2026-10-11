import type { ChecksumMethod } from './media';

/**
 * The production as the local database keeps it (src/main/db) and the
 * screens edit it: settings, shoot days and each day's scene list.
 */

export interface Production {
  name: string;
  code: string;
  frameRate: string;
  checksum: ChecksumMethod;
  totalDays: number;
  devices: { slot: string; name: string; format: string }[];
  /** Naming template tokens, in order, e.g. {PROD}, _, D{DAY}. */
  namingTokens: string[];
  /** How VFX shots are mirrored into the VFX folders (spec §4.9). */
  vfxMethod: MirrorMethod;
}

/**
 * Hard link: the VFX folder's file is the same data as the editorial one, no
 * extra space (same drive, and a filesystem that has links). Reference: a
 * file in the VFX folder saying where the clip is; no media. Physical copy:
 * a separate, verified copy, for a deliverable that must stand alone.
 */
export type MirrorMethod = 'Hard link' | 'Reference' | 'Physical copy';
export const MIRROR_METHODS: MirrorMethod[] = ['Hard link', 'Reference', 'Physical copy'];

export interface ShootDay {
  number: number;
  /** YYYY-MM-DD. */
  date: string;
  /** "Hangar & Rooftop". */
  locations: string;
  operator: { name: string; initials: string };
  /** The DIT's notes for the day: weather, problems, who took what. */
  notes: string;
}

export type SceneStatus = 'Scheduled' | 'Shooting' | 'Shot' | 'Dropped';
export const SCENE_STATUSES: SceneStatus[] = ['Scheduled', 'Shooting', 'Shot', 'Dropped'];

/** A scene on a day's list. Its setups and takes come from the script log and the clips. */
export interface SceneEntry {
  id: string;
  description: string;
  status: SceneStatus;
  notes: string;
  look: string;
}

/** A take as the log and the media make it (spec "Scene / Setup / Take"). */
export interface TakeEntry {
  /** Unique within the day: `${scene}|${setup}|${take}`. */
  id: string;
  /** "T04". */
  take: string;
  /** The A camera's clip ("A015C002"), "—" when there is none yet. */
  clipA: string;
  clipB: string | null;
  sound: string;
  tc: string;
  duration: string;
  circle: boolean;
  vfx: boolean;
  match: 'Matched' | 'Review' | 'Unmatched';
  /** Picture/sound sync; "pending" until the sync step is built. */
  sync: 'TC' | 'WF' | 'none' | 'pending';
}

export interface SetupEntry {
  id: string;
  lens: string;
  takes: TakeEntry[];
}

export interface MatchCandidate {
  clip: string;
  tc: string;
  confidence: number;
  why: string;
}

/** A log entry the DIT has to decide (spec §4.5 Match Review). */
export interface MatchEntry {
  id: string;
  log: string;
  reason: string;
  fields: [string, string][];
  candidates: MatchCandidate[];
  picked: number;
  resolution: null | { kind: 'matched'; clip: string } | { kind: 'wild' };
}

/** One destination's copy of a VFX shot: the editorial clip and its mirror. */
export interface VfxLocation {
  destination: string;
  /** The clip's folder in CAMERA_ORIGINALS. */
  editorial: string;
  /** The take's folder under VFX, once mirrored. */
  mirror: string | null;
  method: MirrorMethod | null;
  state: 'mirrored' | 'failed' | 'pending';
  error: string | null;
}

/** A VFX shot: one camera clip of a take the script supervisor flagged, or the DIT tagged. */
export interface VfxEntry {
  key: string;
  scene: string;
  setup: string;
  /** Two digits: "04". */
  take: string;
  clip: string;
  note: string;
  flaggedBy: 'Script sup.' | 'DIT tag';
  /** Its clip is known (matched in the log). */
  matched: boolean;
  /** Every destination holding a verified copy of the clip. */
  locations: VfxLocation[];
  /** When it was handed to VC VFX Prep. */
  sentAt: string | null;
}

/** One camera clip's sync with production sound (spec "Sync Record"). */
export interface SyncEntry {
  /** `${card}|${clip}`. */
  id: string;
  /** The take it belongs to ("14B-03"), or the clip when the log does not have it. */
  take: string;
  clip: string;
  /** The sound file, or "—". */
  sound: string;
  method: 'Timecode' | 'Waveform' | 'Manual' | 'None';
  /** The correction on top of timecode (or of the waveform's answer), in frames. */
  offsetFrames: number;
  confidence: number;
  accepted: boolean;
  /** The clip's frame rate, for "1 frame @ 23.976 fps". */
  fps: number | null;
  why: string;
  /** Loudness bars of the scratch audio and of the sound as synced, for drawing. */
  barsPicture: number[];
  barsSound: number[];
}

/** A LUT in the production's library (spec §4.7). */
export interface LutEntry {
  id: number;
  name: string;
  title: string;
  kind: '1D' | '3D';
  size: number;
  format: 'cube' | '3dl';
  importedAt: string;
  /** The project-wide rule uses it. */
  isDefault: boolean;
}

export type LutScope = 'Project' | 'Camera' | 'Day' | 'Scene' | 'Setup' | 'Clip';
/** Most specific first: a clip's own rule beats its setup's, and so on down to the project default. */
export const LUT_SCOPES: LutScope[] = ['Clip', 'Setup', 'Scene', 'Day', 'Camera', 'Project'];

export interface LutRuleEntry {
  id: number;
  scope: LutScope;
  /** "Default", a camera letter, a day number, a scene, "14/B", a clip. */
  target: string;
  lut: string;
  lutId: number;
  /** Today's clips this rule decides. */
  clips: number;
}

export interface DailiesSettings {
  include: 'circle' | 'all' | 'scene';
  scenes: string[];
  codec: string;
  resolution: string;
  audio: string;
  look: 'Per assignment rules' | 'Project default only' | 'None · LOG original';
  grouping: 'Scene → Setup → Take' | 'Camera roll' | 'Shoot order';
  /** A destination's id (a volume or a folder), or "" for none chosen. */
  destination: string;
  burnIns: Record<string, boolean>;
}

/** One rendered daily (spec §4.8). */
export interface DailyRender {
  takeId: string;
  label: string;
  clip: string;
  output: string;
  state: 'done' | 'failed';
  error: string | null;
  lut: string | null;
  codec: string;
  bytes: number | null;
  warnings: string[];
}

/** The day's script supervisor log, as last imported. */
export interface LogSummary {
  file: string;
  format: string;
  /** HH:MM, local. */
  importedAt: string;
  entries: number;
  vfxFlags: number;
  matched: number;
  review: number;
  unmatched: number;
  warnings: string[];
}

export interface ProjectState {
  /** The production's database file. */
  file: string;
  production: Production;
  /** The day open now. */
  day: ShootDay;
  days: ShootDay[];
  /** The day's scene list, each with the setups and takes the log gave it. */
  scenes: (SceneEntry & { setups: SetupEntry[] })[];
  log: LogSummary | null;
  /** Log entries waiting on (or decided by) the DIT. */
  matches: MatchEntry[];
  vfx: VfxEntry[];
  /** What the VFX mirroring is doing now ("Copying A015C002 to RAID…"), or null. */
  vfxActivity: string | null;
  /** Every camera clip of the day and its sync. */
  sync: SyncEntry[];
  /** What sync is doing now ("Reading timecode…"), or null. */
  syncActivity: string | null;
  luts: LutEntry[];
  lutRules: LutRuleEntry[];
  /** Camera clips of the day a look can be previewed on. */
  previewClips: { id: string; label: string }[];
  dailies: DailiesSettings;
  renders: DailyRender[];
  /** What dailies rendering is doing now, or null. */
  dailiesActivity: string | null;
  /** The FFmpeg this app renders with, or null when there is none. */
  ffmpeg: { version: string } | null;
  delivery: DeliveryState;
  /** The scene view and the selects on the destinations. */
  organize: OrganizeState;
  /** The day's media in the production: what the Files panel counts. */
  media: { cameraFiles: number; soundFiles: number; cards: number; home: string | null };
  /** Productions opened before, newest first, for switching. */
  recent: { file: string; name: string }[];
}

export type ProjectResult = { ok: true; state: ProjectState } | { ok: false; reason: string };

export const DEFAULT_NAMING = ['{PROD}', '_', 'D{DAY}', '_', 'SC{SCENE}', '{SETUP}', '_', 'T{TAKE}', '_', '{CAM}{REEL}'];

/** Today in the computer's own time zone, as YYYY-MM-DD. */
export const localDate = (date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const DEFAULT_DAILIES: DailiesSettings = {
  include: 'circle',
  scenes: [],
  codec: 'ProRes 422 Proxy',
  resolution: '1920 × 1080 · full frame',
  audio: 'Synced · all tracks mixed',
  look: 'Per assignment rules',
  grouping: 'Scene → Setup → Take',
  destination: '',
  burnIns: { TC: true, 'Scene/Take': true, Look: true, Circle: true, Notes: false, 'Clip name': true, Watermark: false },
};

/** What dailies can be made as (src/main/dailies/render-args.ts). */
export const DAILIES_CODECS = ['ProRes 422 Proxy', 'ProRes 422 LT', 'DNxHR LB', 'H.264 · 10 Mb/s'];
export const DAILIES_RESOLUTIONS = ['1920 × 1080 · letterbox 2.39', '1920 × 1080 · full frame', '1280 × 720 · letterbox 2.39', '1280 × 720 · full frame'];
export const DAILIES_AUDIO = ['Synced · all tracks mixed', 'Synced · track 1 only', 'Camera scratch only', 'No audio'];
export const DAILIES_LOOKS: DailiesSettings['look'][] = ['Per assignment rules', 'Project default only', 'None · LOG original'];
export const DAILIES_GROUPING: DailiesSettings['grouping'][] = ['Scene → Setup → Take', 'Camera roll', 'Shoot order'];

// ------------------------------------------------ delivery (spec §4.10)

/**
 * What a delivery is made of. Each package is a set of the day folder's
 * parts; a part is found on whichever drive holds the most of it (originals
 * on the RAID, dailies wherever they were rendered), and a part two chosen
 * packages share is copied once.
 */
export type DeliveryPartId = 'camera' | 'sound' | 'looks' | 'dailies' | 'vfx' | 'editorial' | 'reports-ingest' | 'reports-dailies' | 'reports';

export const DELIVERY_PARTS: { id: DeliveryPartId; folder: string; exclude?: string[] }[] = [
  // The cards as ingested; the scene view's links are made again on each destination, not copied twice.
  { id: 'camera', folder: 'CAMERA_ORIGINALS', exclude: ['_BY_SCENE'] },
  { id: 'sound', folder: 'SOUND_ORIGINALS' },
  { id: 'looks', folder: 'LUTS_LOOKS' },
  { id: 'dailies', folder: 'SYNCED_DAILIES' },
  { id: 'vfx', folder: 'VFX' },
  // The ALE and sync list, written fresh for each delivery.
  { id: 'editorial', folder: 'EDITORIAL' },
  { id: 'reports-ingest', folder: 'REPORTS/ingest_verification' },
  { id: 'reports-dailies', folder: 'REPORTS/dailies' },
  { id: 'reports', folder: 'REPORTS', exclude: ['ingest_verification', 'dailies'] },
];

export type DeliveryPackageId = 'ocf' | 'edit' | 'dailies' | 'vfx' | 'reports';

export const DELIVERY_PACKAGES: { id: DeliveryPackageId; name: string; description: string; parts: DeliveryPartId[] }[] = [
  { id: 'ocf', name: 'Camera originals archive', description: 'All camera and sound originals, ingest MHL and logs', parts: ['camera', 'sound', 'reports-ingest'] },
  { id: 'edit', name: 'Editorial handoff', description: 'Originals in scene/setup folders, looks, and an ALE and sync list', parts: ['camera', 'sound', 'looks', 'editorial'] },
  { id: 'dailies', name: 'Synced dailies', description: 'The rendered dailies, their looks and manifest', parts: ['dailies', 'looks', 'reports-dailies'] },
  { id: 'vfx', name: 'VFX package', description: 'Mirrored plates and the VC VFX Prep handoff', parts: ['vfx'] },
  { id: 'reports', name: 'Reports & logs', description: 'Ingest, dailies, VFX and delivery reports', parts: ['reports-ingest', 'reports-dailies', 'reports'] },
];

export interface DeliveryPreset {
  name: string;
  packages: DeliveryPackageId[];
  /** Places by id; empty keeps the destinations chosen now. */
  destinations: string[];
}

export const DEFAULT_DELIVERY_PRESETS: DeliveryPreset[] = [
  { name: 'Editorial handoff', packages: ['edit', 'dailies', 'reports'], destinations: [] },
  { name: 'Archive', packages: ['ocf', 'reports'], destinations: [] },
  { name: 'Everything', packages: ['ocf', 'edit', 'dailies', 'vfx', 'reports'], destinations: [] },
];

export interface DeliverySettings {
  packages: DeliveryPackageId[];
  /** The places chosen to deliver to, by id. */
  destinations: string[];
  /** Folders added on this screen only (a NAS share, a vendor's upload folder). */
  folders: { id: string; name: string; path: string }[];
  presets: DeliveryPreset[];
}

export const DEFAULT_DELIVERY: DeliverySettings = { packages: ['edit', 'dailies', 'reports'], destinations: [], folders: [], presets: DEFAULT_DELIVERY_PRESETS };

/** A drive or folder the day's material can come from or go to. */
export interface DeliveryPlace {
  id: string;
  name: string;
  /** "Shuttle", "Archive", "Folder"… */
  kind: string;
  root: string;
  freeBytes: number | null;
  totalBytes: number | null;
}

/** One part of the day folder as found on the drives. */
export interface DeliveryPart {
  id: DeliveryPartId;
  /** The place holding the most of it, or null when no drive has it. */
  sourceId: string | null;
  source: string | null;
  files: number;
  bytes: number;
  /** Bytes of it each other place already holds (same name, same size). */
  present: Record<string, number>;
}

/** One package to one destination: what the manifest says (spec "Delivery Record"). */
export interface DeliveryRecord {
  package: DeliveryPackageId;
  packageName: string;
  destinationId: string;
  destination: string;
  source: string;
  files: number;
  bytes: number;
  verified: number;
  alreadyThere: number;
  failed: number;
  retries: number;
  startedAt: string;
  finishedAt: string;
  /** The first few files that did not verify, and why. */
  problems: { path: string; error: string }[];
  /** The ASC MHL written on the destination, if any. */
  mhl: string | null;
}

export interface DeliveryState {
  settings: DeliverySettings;
  places: DeliveryPlace[];
  parts: DeliveryPart[];
  /** The drives are being looked through. */
  scanning: boolean;
  scannedAt: string | null;
  records: DeliveryRecord[];
  activity: { label: string; totalBytes: number; doneBytes: number; bytesPerSecond: number } | null;
  /** Why the last delivery stopped short, if it did. */
  error: string | null;
}

/** Free space a destination should keep after a copy: 1%, at least 1 GB (as ingest). */
export const deliveryHeadroom = (totalBytes: number): number => Math.max(1e9, totalBytes * 0.01);

/** The parts the chosen packages need, each once. */
export const deliveryParts = (packages: DeliveryPackageId[]): DeliveryPartId[] => {
  const parts = new Set<DeliveryPartId>();
  for (const pkg of DELIVERY_PACKAGES) if (packages.includes(pkg.id)) for (const part of pkg.parts) parts.add(part);
  return DELIVERY_PARTS.map((part) => part.id).filter((id) => parts.has(id));
};

/** Bytes a place still needs for these packages: what it does not already hold, and nothing it is itself the source of. */
export const deliveryNeed = (state: Pick<DeliveryState, 'parts'>, packages: DeliveryPackageId[], placeId: string): number =>
  deliveryParts(packages).reduce((sum, id) => {
    const part = state.parts.find((candidate) => candidate.id === id);
    if (!part || part.sourceId === placeId) return sum;
    return sum + Math.max(0, part.bytes - (part.present[placeId] ?? 0));
  }, 0);

/** A package's size: its parts as found. */
export const packageBytes = (state: Pick<DeliveryState, 'parts'>, id: DeliveryPackageId): { files: number; bytes: number } => {
  const pkg = DELIVERY_PACKAGES.find((candidate) => candidate.id === id)!;
  return pkg.parts.reduce(
    (sum, partId) => {
      const part = state.parts.find((candidate) => candidate.id === partId);
      return { files: sum.files + (part?.files ?? 0), bytes: sum.bytes + (part?.bytes ?? 0) };
    },
    { files: 0, bytes: 0 },
  );
};

// ------------------------------------------------ naming and the scene view (spec §4.4)

/** The parts a naming template can use. */
export const NAMING_FIELDS = ['{PROD}', '{DAY}', '{SCENE}', '{SETUP}', '{TAKE}', '{CAM}', '{REEL}', '{CLIP}'] as const;

/** "{PROD}_D{DAY}_SC{SCENE}" as the tokens the production keeps. */
export const parseNaming = (text: string): string[] =>
  text
    .slice(0, 200)
    .split(/(\{[A-Z]+\}|_)/)
    .filter(Boolean);

/** A take's name by the template: "NJR_D014_SC14B_T04_A015". Originals keep their own names; this names the take's folder. */
export const applyNaming = (
  tokens: string[],
  values: { prod: string; day: number; scene: string; setup: string; take: string; clip: string },
): string => {
  const camera = /^([A-Z])(\d{3})/i.exec(values.clip);
  const fill: Record<string, string> = {
    '{PROD}': values.prod,
    '{DAY}': String(values.day).padStart(3, '0'),
    '{SCENE}': values.scene,
    '{SETUP}': values.setup,
    '{TAKE}': values.take.padStart(2, '0'),
    '{CAM}': camera?.[1]?.toUpperCase() ?? '',
    '{REEL}': camera?.[2] ?? '',
    '{CLIP}': values.clip,
  };
  return tokens
    .join('')
    .replace(/\{[A-Z]+\}/g, (field) => fill[field] ?? field)
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
};

/** Where the day's clips appear by scene, and the circle takes: linked folders, never extra copies. */
export const SCENE_VIEW = 'CAMERA_ORIGINALS/_BY_SCENE';
export const SELECTS_VIEW = 'SELECTS_CIRCLE_TAKES';

export interface OrganizeState {
  /** Clips placed in the scene view, on every destination holding them. */
  placed: number;
  /** Of those, how many are reference files because the drive cannot hold links. */
  references: number;
  failed: number;
  /** Clips (per destination) not yet placed. */
  pending: number;
  /** The scene view's folder on each destination. */
  folders: { destination: string; path: string }[];
  problems: { clip: string; destination: string; error: string }[];
  activity: string | null;
}

// ------------------------------------------------ reports

/** One report of the day, as the Reports screen lists it. */
export interface ReportEntry {
  id: string;
  step: 'verify' | 'organize' | 'vfx' | 'sync' | 'output';
  /** The screen it comes from. */
  screen: 'verify' | 'match' | 'scenes' | 'vfx' | 'sync' | 'looks' | 'dailies' | 'delivery';
  name: string;
  covers: string;
  /** ISO time it was last written, or null. */
  time: string | null;
  status: 'done' | 'needs' | 'problem' | 'working' | 'idle';
  word: string;
  /** For an ingest: the card, so a running transfer can show live. */
  card?: string;
  /** Its files on the drives (MHL, CSV, manifests), the first being the one to show. */
  files: string[];
}
