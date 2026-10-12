import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowseRoot, IngestRequest, VolumeRole } from '../../shared/media';
import { FORMAT_RULES, type FormatRule } from '../../shared/project';
import { inside, listFolder, searchFolder } from './browse';
import { segment } from './rules';
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
  ipcMain.handle('vcdit:media-drive-limit', (_e, id: unknown, bytesPerSecond: unknown) => service.setDriveLimit(String(id), typeof bytesPerSecond === 'number' ? bytesPerSecond : null));
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
  // The Files panel: what is really in the production's folder on each destination. Read-only, and only there.
  const productionRoot = (id: unknown, production: unknown): string | null => {
    const destination = service.destinations().find((candidate) => candidate.id === id);
    if (!destination || typeof production !== 'string' || !production.trim()) return null;
    return join(destination.root, segment(production));
  };
  ipcMain.handle('vcdit:files-roots', async (_e, production: unknown): Promise<BrowseRoot[]> =>
    Promise.all(
      service.destinations().map(async (destination) => {
        const path = typeof production === 'string' && production.trim() ? join(destination.root, segment(production)) : destination.root;
        const present = await stat(path).then((info) => info.isDirectory(), () => false);
        return { id: destination.id, name: destination.name, path, present };
      }),
    ),
  );
  ipcMain.handle('vcdit:files-list', (_e, id: unknown, production: unknown, rel: unknown) => {
    const root = productionRoot(id, production);
    return root ? listFolder(root, typeof rel === 'string' ? rel : '') : { ok: false, reason: 'That drive is no longer available.' };
  });
  ipcMain.handle('vcdit:files-search', (_e, id: unknown, production: unknown, query: unknown) => {
    const root = productionRoot(id, production);
    return root ? searchFolder(root, typeof query === 'string' ? query.slice(0, 120) : '') : { ok: false, reason: 'That drive is no longer available.' };
  });
  ipcMain.handle('vcdit:files-reveal', (_e, id: unknown, production: unknown, rel: unknown, open: unknown) => {
    const root = productionRoot(id, production);
    const path = root && typeof rel === 'string' ? inside(root, rel) : null;
    if (!path) return;
    if (open === true) void shell.openPath(path);
    else shell.showItemInFolder(path);
  });

  const rule = (value: unknown): FormatRule => (FORMAT_RULES.includes(value as FormatRule) ? (value as FormatRule) : 'two-local');
  ipcMain.handle('vcdit:media-check-clear', (_e, jobId: unknown, value: unknown) => service.checkClear(String(jobId), rule(value)));
  ipcMain.handle('vcdit:media-clear', (_e, jobId: unknown, value: unknown) => service.clearCard(String(jobId), rule(value)));

  ipcMain.handle('vcdit:media-eject', (_e, volumeId: unknown) => service.eject(String(volumeId)));

  ipcMain.handle('vcdit:media-retry', (_e, jobId: unknown, legId: unknown) => service.retry(String(jobId), String(legId)));
  ipcMain.handle('vcdit:media-show', (_e, path: unknown) => {
    // Only folders the engine wrote to.
    const known = service.state().jobs.some((job) => job.legs.some((leg) => leg.targetDir === path));
    if (known) shell.showItemInFolder(String(path));
  });

  await service.start();
  return service;
};
