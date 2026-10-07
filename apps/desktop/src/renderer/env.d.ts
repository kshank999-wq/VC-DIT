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
  saveLogTemplate: () => Promise<ProjectResult>;
  tagVfx: (clip: string, note: string) => Promise<ProjectResult>;
  mirrorVfx: () => Promise<ProjectResult>;
  sendVfx: () => Promise<ProjectResult>;
}
