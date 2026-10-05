import { contextBridge, ipcRenderer } from 'electron';

/** What the renderer may ask of its host. Today, the license; the media engine's calls join it as they are built. */
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
});
