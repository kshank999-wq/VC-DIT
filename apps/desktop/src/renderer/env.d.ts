/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

/** The license as the main process reports it (src/main/licensing.ts). */
interface Access {
  plan: 'dit' | 'none';
  state: 'licensed' | 'not-activated' | 'expired-offline' | 'not-configured';
  email: string | null;
  serial: string | null;
  paidThrough: string | null;
  validUntil: string | null;
  message: string | null;
}

/** Whether the open production can send its day to VC Film Studio (src/main/film-studio-link.ts). */
interface FilmStudioLink {
  linked: boolean;
  /** "vcdit_…x9Qa": the key's last four characters, never the key. */
  hint: string | null;
  endpoint: string;
}

/** What the preload exposes (src/preload/index.ts). Absent in a test or a plain browser. */
interface Window {
  vcdit?: {
    platform: string;
    desktop: true;
    license: {
      now: () => Access;
      onChange: (listener: (access: Access) => void) => () => void;
      activate: (code: string) => Promise<Access>;
      refresh: () => Promise<Access>;
      deactivate: () => Promise<Access>;
      open: (page: 'pricing' | 'download' | 'account') => Promise<void>;
    };
    /** May the app listen to an audio input (the sync box's timecode)? Asks on macOS. Absent in the browser preview. */
    microphone?: () => Promise<boolean>;
    /** The production database (src/main/db). Absent in the browser preview, which runs on the demo day. */
    project?: ProjectApi;
    /** The media engine (src/main/media). Absent in the browser preview. */
    media?: MediaApi;
  };
}

type MediaState = import('../shared/media').MediaState;

interface MediaApi {
  state: () => Promise<MediaState>;
  onChange: (listener: (state: MediaState) => void) => () => void;
  setRole: (volumeId: string, role: import('../shared/media').VolumeRole) => Promise<{ ok: boolean; reason?: string }>;
  addFolder: () => Promise<{ ok: boolean; reason?: string }>;
  removeFolder: (id: string) => Promise<void>;
  ingest: (request: import('../shared/media').IngestRequest) => Promise<import('../shared/media').IngestResult>;
  retry: (jobId: string, legId: string) => Promise<import('../shared/media').IngestResult>;
  /** Stop a card's transfer and its uploads, or with a leg named, just that upload. */
  stopJob: (jobId: string, legId?: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Feed this destination from the backup (an upload) rather than the card. */
  setRelay: (id: string, relay: boolean) => Promise<{ ok: boolean; reason?: string }>;
  pauseRelays: (paused: boolean) => Promise<void>;
  /** Most bytes a second uploads may write; null for no limit. */
  setRelayLimit: (bytesPerSecond: number | null) => Promise<void>;
  /** The system's own icon for a drive or folder (Explorer's on Windows, Finder's on macOS), as a data URL; null where there is none. */
  icon: (path: string) => Promise<string | null>;
  /** Eject a card or drive, as Finder or Explorer would; ok once it has really gone. */
  eject: (volumeId: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Is everything on this card safely elsewhere, checked now (nothing changes)? */
  checkClear: (jobId: string, rule: import('../shared/project').FormatRule) => Promise<import('../shared/media').ClearCheck | { ok: false; problems: string[] }>;
  /** Erase the card's ingested files, after checking again. */
  clearCard: (jobId: string, rule: import('../shared/project').FormatRule) => Promise<import('../shared/media').ClearResult>;
  /** The Files panel: each destination, and whether the production's folder is on it. */
  browseRoots: (production: string) => Promise<import('../shared/media').BrowseRoot[]>;
  /** One folder under the production's folder on a destination (rel '' is the production's folder). */
  browse: (id: string, production: string, rel: string) => Promise<import('../shared/media').BrowseListing>;
  browseSearch: (id: string, production: string, query: string) => Promise<import('../shared/media').BrowseSearch>;
  /** Show it in Finder or Explorer, or (open) open it with its app. */
  reveal: (id: string, production: string, rel: string, open?: boolean) => Promise<void>;
  show: (path: string) => Promise<void>;
}

type ProjectState = import('../shared/project').ProjectState;
type ProjectResult = import('../shared/project').ProjectResult;

interface ProjectApi {
  now: () => ProjectState;
  onChange: (listener: (state: ProjectState) => void) => () => void;
  update: (patch: Partial<import('../shared/project').Production>) => Promise<ProjectResult>;
  updateDay: (patch: Partial<Omit<import('../shared/project').ShootDay, 'number'>>) => Promise<ProjectResult>;
  addScene: (scene: { id: string; description?: string }) => Promise<ProjectResult>;
  updateScene: (id: string, patch: Partial<Omit<import('../shared/project').SceneEntry, 'id'>>) => Promise<ProjectResult>;
  removeScene: (id: string) => Promise<ProjectResult>;
  addDay: () => Promise<ProjectResult>;
  openDay: (number: number) => Promise<ProjectResult>;
  create: () => Promise<ProjectResult>;
  open: (file?: string) => Promise<ProjectResult>;
  saveCopy: () => Promise<ProjectResult>;
  reveal: () => Promise<void>;
  importLog: () => Promise<ProjectResult>;
  resolveMatch: (id: string, clip: string | null) => Promise<ProjectResult>;
  /** One card's camera report, replacing what it had. */
  setCameraReport: (card: string, rows: import('../shared/project').CameraReportInput[]) => Promise<ProjectResult>;
  importCameraReport: () => Promise<ProjectResult>;
  /** The day's camera report from VC Film Studio, with the production's upload key. */
  pullCameraReport: () => Promise<ProjectResult>;
  /** Seal a drive before it leaves set: check it against every copy made to it, then write a manifest to it. */
  seal: (id: string, verify: boolean) => Promise<import('../shared/media').SealResult>;
  stopSeal: () => Promise<void>;
  onSealProgress: (listener: (progress: { id: string; files: number; totalFiles: number; bytes: number; totalBytes: number; file: string | null }) => void) => () => void;
  saveReportTemplate: () => Promise<ProjectResult>;
  /** Where clips go, in the DIT's own word; null takes them back to what the sources say. */
  assign: (clips: { card: string; clip: string }[], slate: import('../shared/project').SlateInput | null) => Promise<ProjectResult>;
  saveLogTemplate: () => Promise<ProjectResult>;
  tagVfx: (clip: string, note: string) => Promise<ProjectResult>;
  mirrorVfx: () => Promise<ProjectResult>;
  sendVfx: () => Promise<ProjectResult>;
  syncWaveform: () => Promise<ProjectResult>;
  syncNudge: (id: string, frames: number) => Promise<ProjectResult>;
  syncAccept: (ids: string[]) => Promise<ProjectResult>;
  importLuts: () => Promise<ProjectResult>;
  removeLut: (id: number) => Promise<ProjectResult>;
  setLutRule: (scope: import('../shared/project').LutScope, target: string, lutId: number) => Promise<ProjectResult>;
  removeLutRule: (id: number) => Promise<ProjectResult>;
  previewLook: (clipId: string, lutId: number | null) => Promise<{ ok: true; original: string; graded: string | null } | { ok: false; reason: string }>;
  saveDailies: (settings: import('../shared/project').DailiesSettings) => Promise<ProjectResult>;
  startDailies: (settings: import('../shared/project').DailiesSettings) => Promise<ProjectResult>;
  stopDailies: () => Promise<ProjectResult>;
  saveDelivery: (settings: Partial<import('../shared/project').DeliverySettings>) => Promise<ProjectResult>;
  refreshDelivery: () => Promise<ProjectResult>;
  startDelivery: () => Promise<ProjectResult>;
  stopDelivery: () => Promise<ProjectResult>;
  retryDelivery: (pkg: string, destination: string) => Promise<ProjectResult>;
  addDeliveryFolder: () => Promise<ProjectResult>;
  removeDeliveryFolder: (id: string) => Promise<ProjectResult>;
  saveManifest: () => Promise<ProjectResult>;
  showManifest: (path: string) => Promise<void>;
  showSceneFolder: (path: string) => Promise<void>;
  /** Read the scene folders back on every destination now. */
  checkSceneFolders: () => Promise<ProjectResult>;
  /** Put back what the check found missing or wrong. */
  repairSceneFolders: () => Promise<ProjectResult>;
  reports: () => Promise<import('../shared/project').ReportEntry[]>;
  addNote: (note: Omit<import('../shared/project').NoteInput, 'at'>) => Promise<ProjectResult>;
  updateNote: (id: number, patch: Partial<Pick<import('../shared/project').DayNote, 'text' | 'scope' | 'scene' | 'setup' | 'take' | 'clip'>>) => Promise<ProjectResult>;
  removeNote: (id: number) => Promise<ProjectResult>;
  thumbnail: (clip: string, options: { look: boolean; size: 'small' | 'large' }) => Promise<{ ok: true; url: string } | { ok: false; reason: string }>;
  showReport: (path: string) => Promise<void>;
  dayReport: (where: 'save' | 'drives') => Promise<{ ok: true; written: string[] } | { ok: false; reason: string }>;
  filmStudio: (where: 'save' | 'drives') => Promise<{ ok: true; written: string[] } | { ok: false; reason: string }>;
  /** Post the day's log to the production in VC Film Studio with its upload key. */
  sendToFilmStudio: () => Promise<{ ok: true; text: string; warnings: string[] } | { ok: false; reason: string }>;
  /** Whether the open production can send its day to VC Film Studio. Never the key itself. */
  filmStudioLink: () => Promise<FilmStudioLink>;
  setFilmStudioKey: (key: string) => Promise<{ ok: true; link: FilmStudioLink } | { ok: false; reason: string }>;
  clearFilmStudioKey: () => Promise<FilmStudioLink>;
  showDaily: (path: string) => Promise<void>;
}
