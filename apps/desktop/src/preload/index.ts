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
  /** May the app listen to an audio input (the sync box's timecode)? Asks on macOS. */
  microphone: (): Promise<boolean> => ipcRenderer.invoke('vcdit:microphone'),
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
    setCameraReport: (card: string, rows: unknown[]): Promise<unknown> => ipcRenderer.invoke('vcdit:project-camera-report', card, rows),
    importCameraReport: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-import-camera-report'),
    pullCameraReport: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-pull-camera-report'),
    seal: (id: string, verify: boolean): Promise<unknown> => ipcRenderer.invoke('vcdit:project-seal', id, verify),
    stopSeal: (): Promise<void> => ipcRenderer.invoke('vcdit:project-seal-stop'),
    onSealProgress: (listener: (progress: unknown) => void): (() => void) => {
      const handler = (_e: unknown, progress: unknown) => listener(progress);
      ipcRenderer.on('vcdit:seal-progress', handler);
      return () => ipcRenderer.removeListener('vcdit:seal-progress', handler);
    },
    saveReportTemplate: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-save-report-template'),
    assign: (clips: { card: string; clip: string }[], slate: unknown): Promise<unknown> => ipcRenderer.invoke('vcdit:project-assign', clips, slate),
    saveLogTemplate: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-save-log-template'),
    tagVfx: (clip: string, note: string): Promise<unknown> => ipcRenderer.invoke('vcdit:project-vfx-tag', clip, note),
    mirrorVfx: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-vfx-mirror'),
    sendVfx: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-vfx-send'),
    syncWaveform: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-sync-waveform'),
    syncNudge: (id: string, frames: number): Promise<unknown> => ipcRenderer.invoke('vcdit:project-sync-nudge', id, frames),
    syncAccept: (ids: string[]): Promise<unknown> => ipcRenderer.invoke('vcdit:project-sync-accept', ids),
    importLuts: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-lut-import'),
    removeLut: (id: number): Promise<unknown> => ipcRenderer.invoke('vcdit:project-lut-remove', id),
    setLutRule: (scope: string, target: string, lutId: number): Promise<unknown> => ipcRenderer.invoke('vcdit:project-lut-rule', scope, target, lutId),
    removeLutRule: (id: number): Promise<unknown> => ipcRenderer.invoke('vcdit:project-lut-rule-remove', id),
    previewLook: (clipId: string, lutId: number | null): Promise<unknown> => ipcRenderer.invoke('vcdit:project-look-preview', clipId, lutId),
    saveDailies: (settings: unknown): Promise<unknown> => ipcRenderer.invoke('vcdit:project-dailies-settings', settings),
    startDailies: (settings: unknown): Promise<unknown> => ipcRenderer.invoke('vcdit:project-dailies-start', settings),
    stopDailies: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-dailies-stop'),
    showDaily: (path: string): Promise<void> => ipcRenderer.invoke('vcdit:project-dailies-show', path),
    saveDelivery: (settings: unknown): Promise<unknown> => ipcRenderer.invoke('vcdit:project-delivery-settings', settings),
    refreshDelivery: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-delivery-refresh'),
    startDelivery: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-delivery-start'),
    stopDelivery: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-delivery-stop'),
    retryDelivery: (pkg: string, destination: string): Promise<unknown> => ipcRenderer.invoke('vcdit:project-delivery-retry', pkg, destination),
    addDeliveryFolder: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-delivery-add-folder'),
    removeDeliveryFolder: (id: string): Promise<unknown> => ipcRenderer.invoke('vcdit:project-delivery-remove-folder', id),
    saveManifest: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-delivery-save-manifest'),
    showManifest: (path: string): Promise<void> => ipcRenderer.invoke('vcdit:project-delivery-show', path),
    showSceneFolder: (path: string): Promise<void> => ipcRenderer.invoke('vcdit:project-organize-show', path),
    checkSceneFolders: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-organize-check'),
    repairSceneFolders: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-organize-repair'),
    reports: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-reports'),
    addNote: (note: unknown): Promise<unknown> => ipcRenderer.invoke('vcdit:project-note-add', note),
    updateNote: (id: number, patch: unknown): Promise<unknown> => ipcRenderer.invoke('vcdit:project-note-update', id, patch),
    removeNote: (id: number): Promise<unknown> => ipcRenderer.invoke('vcdit:project-note-remove', id),
    thumbnail: (clip: string, options: { look: boolean; size: 'small' | 'large' }): Promise<unknown> => ipcRenderer.invoke('vcdit:project-thumbnail', clip, options),
    showReport: (path: string): Promise<void> => ipcRenderer.invoke('vcdit:project-report-show', path),
    dayReport: (where: 'save' | 'drives'): Promise<unknown> => ipcRenderer.invoke('vcdit:project-day-report', where),
    filmStudio: (where: 'save' | 'drives'): Promise<unknown> => ipcRenderer.invoke('vcdit:project-film-studio', where),
    sendToFilmStudio: (): Promise<unknown> => ipcRenderer.invoke('vcdit:project-film-studio', 'send'),
    filmStudioLink: (): Promise<unknown> => ipcRenderer.invoke('vcdit:film-studio-link'),
    setFilmStudioKey: (key: string): Promise<unknown> => ipcRenderer.invoke('vcdit:film-studio-link-set', key),
    clearFilmStudioKey: (): Promise<unknown> => ipcRenderer.invoke('vcdit:film-studio-link-clear'),
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
    stopJob: (jobId: string, legId?: string): Promise<unknown> => ipcRenderer.invoke('vcdit:media-stop', jobId, legId),
    setRelay: (id: string, relay: boolean): Promise<unknown> => ipcRenderer.invoke('vcdit:media-set-relay', id, relay),
    pauseRelays: (paused: boolean): Promise<unknown> => ipcRenderer.invoke('vcdit:media-pause-relays', paused),
    setRelayLimit: (bytesPerSecond: number | null): Promise<unknown> => ipcRenderer.invoke('vcdit:media-relay-limit', bytesPerSecond),
    setDriveLimit: (id: string, bytesPerSecond: number | null): Promise<unknown> => ipcRenderer.invoke('vcdit:media-drive-limit', id, bytesPerSecond),
    icon: (path: string): Promise<unknown> => ipcRenderer.invoke('vcdit:media-icon', path),
    eject: (volumeId: string): Promise<unknown> => ipcRenderer.invoke('vcdit:media-eject', volumeId),
    checkClear: (jobId: string, rule: string): Promise<unknown> => ipcRenderer.invoke('vcdit:media-check-clear', jobId, rule),
    clearCard: (jobId: string, rule: string): Promise<unknown> => ipcRenderer.invoke('vcdit:media-clear', jobId, rule),
    browseRoots: (production: string): Promise<unknown> => ipcRenderer.invoke('vcdit:files-roots', production),
    browse: (id: string, production: string, rel: string): Promise<unknown> => ipcRenderer.invoke('vcdit:files-list', id, production, rel),
    browseSearch: (id: string, production: string, query: string): Promise<unknown> => ipcRenderer.invoke('vcdit:files-search', id, production, query),
    reveal: (id: string, production: string, rel: string, open?: boolean): Promise<unknown> => ipcRenderer.invoke('vcdit:files-reveal', id, production, rel, open === true),
    show: (path: string): Promise<void> => ipcRenderer.invoke('vcdit:media-show', path),
  },
});
