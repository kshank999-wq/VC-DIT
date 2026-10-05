import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { registerLicensing } from './licensing-ipc';

/**
 * Electron main process for VC DIT.
 *
 * Today it owns the window and the license. The media engine (volume
 * detection, verified multi-destination copy, checksums, sync, transcode) will
 * live here and in worker processes, never in the renderer: it touches camera
 * originals, and only this side has the disk. See docs/ARCHITECTURE.md.
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
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
