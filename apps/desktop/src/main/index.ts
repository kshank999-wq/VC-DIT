import { app, BrowserWindow, dialog, shell } from 'electron';
import { join } from 'node:path';
import { registerLicensing } from './licensing-ipc';
import type { Library } from './db/library';
import { registerProject } from './db/project-ipc';
import type { MediaService } from './media/media-service';
import type { DailiesService } from './dailies/dailies-service';
import type { DeliveryService } from './delivery/delivery-service';
import type { SyncService } from './sync/sync-service';
import type { VfxService } from './vfx/vfx-service';
import { registerMedia } from './media/media-ipc';

/**
 * Electron main process for VC DIT.
 *
 * It owns the window, the license, the production database (src/main/db)
 * and the media engine (src/main/media: volume detection, the verified
 * multi-destination copy, checksums, manifests). The engine lives here and in worker threads, never in the
 * renderer: it touches camera originals, and only this side has the disk.
 * See docs/ARCHITECTURE.md.
 */

const createMainWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'VC DIT',
    backgroundColor: '#0b0a07',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.once('ready-to-show', () => window.show());
  // Links open in the browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) void window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
  return window;
};

let library: Library | null = null;
let media: MediaService | null = null;
let vfx: VfxService | null = null;
let sync: SyncService | null = null;
let dailies: DailiesService | null = null;
let delivery: DeliveryService | null = null;

void app.whenReady().then(async () => {
  // Before the first window, so it opens knowing whether transfers may start and which production is open.
  await registerLicensing();
  const project = await registerProject({
    busy: () => media?.busy() ?? false,
    opened: (transfers) => media?.load(transfers),
    destinations: () => media?.destinations() ?? [],
  });
  library = project.library;
  vfx = project.vfx;
  sync = project.sync;
  dailies = project.dailies;
  delivery = project.delivery;
  const open = library;
  media = await registerMedia((transfer) => {
    open.current.saveTransfer(transfer);
    // A card that just finished may hold clips the script log is waiting for.
    if (transfer.finishedAt) project.cardIn(transfer.day);
  });
  media.load(open.current.transfers(open.current.currentDay().number));
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// Quitting mid-transfer leaves a card not safe to format: ask first. Then
// let the transfer clean up and the production database finish writing.
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  if (media?.busy()) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Keep copying', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'A transfer is still running.',
      detail: 'If you quit now, the card being copied is not safe to format. Unverified copies are removed; start the ingest again to finish it.',
    });
    if (choice === 0) {
      event.preventDefault();
      return;
    }
  }
  event.preventDefault();
  quitting = true;
  void (async () => {
    if (media?.busy()) {
      media.stop();
      await media.idle(15_000);
    }
    dailies?.stop();
    delivery?.stop();
    await delivery?.idle();
    await vfx?.idle();
    await sync?.idle();
    await library?.close().catch(() => undefined);
    app.quit();
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
