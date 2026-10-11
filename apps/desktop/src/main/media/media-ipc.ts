import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IngestRequest, VolumeRole } from '../../shared/media';
import type { TransferRecord } from '../db/production-db';
import { licensing } from '../licensing-ipc';
import { MediaService } from './media-service';
import transferWorkerPath from './transfer-worker?modulePath';

/**
 * The media engine wired to the app: the service, the windows told when
 * volumes or transfers change, and the calls the screens may make
 * (window.vcdit.media in the preload).
 */

const ROLES: VolumeRole[] = ['Camera', 'Sound', 'Destination', 'Shuttle', 'Archive', 'Other'];

export const registerMedia = async (record: (transfer: TransferRecord) => void): Promise<MediaService> => {
  const service = new MediaService({
    dataDir: app.getPath('userData'),
    workerPath: transferWorkerPath,
    tool: { name: 'VC DIT', version: app.getVersion() },
    canStartTransfers: () => licensing.canStartTransfers(),
    onRecord: record,
    onChange: (state) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('vcdit:media', state);
    },
  });

  ipcMain.handle('vcdit:media-state', () => service.state());
  ipcMain.handle('vcdit:media-set-role', (_e, volumeId: unknown, role: unknown) => {
    if (!ROLES.includes(role as VolumeRole)) return { ok: false, reason: 'Unknown role.' };
    return service.setRole(String(volumeId), role as VolumeRole);
  });
  ipcMain.handle('vcdit:media-add-folder', async (e) => {
    const window = BrowserWindow.fromWebContents(e.sender);
    const options = { title: 'Pick a destination folder', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return { ok: false };
    return service.addFolder(picked.filePaths[0]);
  });
  ipcMain.handle('vcdit:media-remove-folder', (_e, id: unknown) => service.removeFolder(String(id)));
  ipcMain.handle('vcdit:media-ingest', (_e, request: unknown) => service.ingest(request as IngestRequest));
  ipcMain.handle('vcdit:media-stop', (_e, jobId: unknown, legId: unknown) => service.stopJob(String(jobId), typeof legId === 'string' ? legId : undefined));
  ipcMain.handle('vcdit:media-set-relay', (_e, id: unknown, relay: unknown) => service.setRelay(String(id), relay === true));
  ipcMain.handle('vcdit:media-pause-relays', (_e, paused: unknown) => service.pauseRelays(paused === true));
  ipcMain.handle('vcdit:media-relay-limit', (_e, bytesPerSecond: unknown) => service.setRelayLimit(typeof bytesPerSecond === 'number' ? bytesPerSecond : null));
  // The system's own picture of a drive or folder, so they look as they do in Explorer or Finder.
  const icons = new Map<string, string | null>();
  ipcMain.handle('vcdit:media-icon', async (_e, path: unknown) => {
    if (typeof path !== 'string') return null;
    const state = service.state();
    const known = state.volumes.some((volume) => volume.mountPath === path) || state.folders.some((folder) => folder.path === path);
    if (!known) return null;
    if (!icons.has(path)) {
      try {
        const image = await app.getFileIcon(path, { size: 'large' });
        icons.set(path, image.isEmpty() ? null : image.toDataURL());
      } catch {
        icons.set(path, null);
      }
    }
    return icons.get(path) ?? null;
  });
  ipcMain.handle('vcdit:media-retry', (_e, jobId: unknown, legId: unknown) => service.retry(String(jobId), String(legId)));
  ipcMain.handle('vcdit:media-show', (_e, path: unknown) => {
    // Only folders the engine wrote to.
    const known = service.state().jobs.some((job) => job.legs.some((leg) => leg.targetDir === path));
    if (known) shell.showItemInFolder(String(path));
  });

  await service.start();
  return service;
};
