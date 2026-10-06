import { app, BrowserWindow, dialog, shell } from 'electron';
import { join } from 'node:path';
import { registerLicensing } from './licensing-ipc';
import { media, registerMedia } from './media/media-ipc';

/**
 * Electron main process for VC DIT.
 *
 * It owns the window, the license and the media engine (src/main/media:
 * volume detection, the verified multi-destination copy, checksums,
 * manifests). The engine lives here and in worker threads, never in the
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

void app.whenReady().then(async () => {
  // Before the first window, so it opens knowing whether transfers may start.
  await registerLicensing();
  await registerMedia();
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// Quitting mid-transfer leaves a card not safe to format: ask first.
app.on('before-quit', (event) => {
  if (!media?.busy()) return;
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['Keep copying', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
    message: 'A transfer is still running.',
    detail: 'If you quit now, the card being copied is not safe to format. Unverified copies are removed; start the ingest again to finish it.',
  });
  if (choice === 0) event.preventDefault();
  else media.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
