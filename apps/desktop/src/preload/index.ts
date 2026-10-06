import { contextBridge, ipcRenderer } from 'electron';

/** What the renderer may ask of its host: the license and the media engine. */
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
