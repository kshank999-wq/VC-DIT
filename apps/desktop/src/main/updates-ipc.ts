import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SMOKE } from './smoke';
import { releasePlatform, Updater, type Kept } from './updates';

/**
 * The update check wired to the app: the site the build talks to, what the
 * person put off or skipped (kept in the app's folder), the windows told
 * when it changes, and a check shortly after start and every six hours.
 * The launch check (VCDIT_SMOKE) never asks the network.
 */

const site = (import.meta.env.MAIN_VITE_SITE_URL || 'https://vc-dit.com').replace(/\/+$/, '');
const file = () => join(app.getPath('userData'), 'updates.json');
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 20_000;

export const registerUpdates = async (): Promise<void> => {
  const updater = new Updater({
    site,
    current: app.getVersion(),
    platform: releasePlatform(process.platform),
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    load: async () => {
      const kept = JSON.parse(await readFile(file(), 'utf8')) as Partial<Kept>;
      return { skipped: typeof kept.skipped === 'string' ? kept.skipped : null, snoozedUntil: Number(kept.snoozedUntil) || 0 };
    },
    save: async (kept) => {
      await mkdir(app.getPath('userData'), { recursive: true });
      await writeFile(file(), JSON.stringify(kept), 'utf8');
    },
    changed: (state) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('vcdit:update', state);
    },
  });
  await updater.start();

  ipcMain.on('vcdit:update-now', (e) => {
    e.returnValue = updater.view();
  });
  ipcMain.handle('vcdit:update-check', () => updater.check());
  ipcMain.handle('vcdit:update-dismiss', (_e, how: unknown) => updater.dismiss(how === 'skip' ? 'skip' : 'later'));

  if (SMOKE) return;
  setTimeout(() => void updater.check(), FIRST_CHECK_MS).unref?.();
  setInterval(() => void updater.check(), CHECK_EVERY_MS).unref?.();
};
