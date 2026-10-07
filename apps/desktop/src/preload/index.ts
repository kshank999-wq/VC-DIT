import { contextBridge, ipcRenderer } from 'electron';

/** What the renderer may ask of its host: the license, the production database and the media engine. */
contextBridge.exposeInMainWorld('vcdit', {
  platform: process.platform,
  desktop: true,
  /** The license (src/main/licensing.ts): whether new transfers may start, and activating with the authorization code. */
  license: {
    now: (): unknown => ipcRenderer.sendSync('vcdit:license-now'),
    onChange: (listener: (access: unknown) => void): (() => void) => {
      const handler = (_e: unknown, access: unknown) => listener(access);
      ipcRenderer.on('vcdit:license', handler);
      return () => ipcRenderer.removeListener('vcdit:license', handler);
    },
    activate: (code: string): Promise<unknown> => ipcRenderer.invoke('vcdit:license-activate', code),
    refresh: (): Promise<unknown> => ipcRenderer.invoke('vcdit:license-refresh'),
    deactivate: (): Promise<unknown> => ipcRenderer.invoke('vcdit:license-deactivate'),
    open: (page: string): Promise<void> => ipcRenderer.invoke('vcdit:license-open', page),
  },
  /** The production database (src/main/db): settings, shoot days, scene lists. */
  project: {
    now: (): unknown => ipcRenderer.sendSync('vcdit:project-now'),
    onChange: (listener: (state: unknown) => void): (() => void) => {
      const handler = (_e: unknown, state: unknown) => listener(state);
      ipcRenderer.on('vcdit:project', handler);
      return () => ipcRenderer.removeListener('vcdit:project', handler);
    },
    update: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('vcdit:project-update', patch),
    updateDay: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('vcdit:project-update-day', patch),
    addScene: (scene: unknown): Promise<unknown> => ipcRenderer.invoke('vcdit:project-add-scene', scene),
    updateScene: (id: string, patch: unknown): Promise<unknown> => ipcRenderer.invoke('vcdit:project-update-scene', id, patch),
    removeScene: (id: string): Promise<unknown> => ipcRenderer.invoke('vcdit:project-remove-scene', id),
    addDay: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-add-day'),
    openDay: (number: number): Promise<unknown> => ipcRenderer.invoke('vcdit:project-open-day', number),
    create: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-new'),
    open: (file?: string): Promise<unknown> => ipcRenderer.invoke('vcdit:project-open', file),
    saveCopy: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-save-copy'),
    reveal: (): Promise<void> => ipcRenderer.invoke('vcdit:project-reveal'),
    importLog: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-import-log'),
    resolveMatch: (id: string, clip: string | null): Promise<unknown> => ipcRenderer.invoke('vcdit:project-resolve-match', id, clip),
    saveLogTemplate: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-save-log-template'),
    tagVfx: (clip: string, note: string): Promise<unknown> => ipcRenderer.invoke('vcdit:project-vfx-tag', clip, note),
    mirrorVfx: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-vfx-mirror'),
    sendVfx: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-vfx-send'),
    syncWaveform: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-sync-waveform'),
    syncNudge: (id: string, frames: number): Promise<unknown> => ipcRenderer.invoke('vcdit:project-sync-nudge', id, frames),
    syncAccept: (ids: string[]): Promise<unknown> => ipcRenderer.invoke('vcdit:project-sync-accept', ids),
  },
  /** The media engine (src/main/media): volumes, destination folders, transfers. */
  media: {
    state: (): Promise<unknown> => ipcRenderer.invoke('vcdit:media-state'),
    onChange: (listener: (state: unknown) => void): (() => void) => {
      const handler = (_e: unknown, state: unknown) => listener(state);
      ipcRenderer.on('vcdit:media', handler);
      return () => ipcRenderer.removeListener('vcdit:media', handler);
    },
    setRole: (volumeId: string, role: string): Promise<unknown> => ipcRenderer.invoke('vcdit:media-set-role', volumeId, role),
    addFolder: (): Promise<unknown> => ipcRenderer.invoke('vcdit:media-add-folder'),
    removeFolder: (id: string): Promise<void> => ipcRenderer.invoke('vcdit:media-remove-folder', id),
    ingest: (request: unknown): Promise<unknown> => ipcRenderer.invoke('vcdit:media-ingest', request),
    retry: (jobId: string, legId: string): Promise<unknown> => ipcRenderer.invoke('vcdit:media-retry', jobId, legId),
    show: (path: string): Promise<void> => ipcRenderer.invoke('vcdit:media-show', path),
  },
});
