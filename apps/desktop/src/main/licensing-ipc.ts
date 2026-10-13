import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deviceFingerprint, deviceName, devicePlatform } from './device';
import { publicKeyFrom } from './license-token';
import { Licensing, type Access, type Stored } from './licensing';

/**
 * The license wired to the app: configuration from the build, the kept file,
 * the windows told when it changes, and a check-in every few hours.
 *
 * The two values come from the release build's environment (MAIN_VITE_*, see
 * docs/DEPLOYMENT.md). A build without the public key, a developer's
 * `npm run dev`, is unlicensed-but-unlocked ("not configured") so the app can
 * be worked on; the release workflow refuses to package without it.
 */

const config = {
  siteUrl: (import.meta.env.MAIN_VITE_SITE_URL || 'https://vc-dit.com').replace(/\/+$/, ''),
  publicKey: publicKeyFrom(import.meta.env.MAIN_VITE_LICENSE_PUBLIC_KEY || ''),
};

const file = () => join(app.getPath('userData'), 'license.json');
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const seal = (value: string | null): string | null =>
  value && safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(value).toString('base64')}` : value;
const unseal = (value: string | null): string | null => {
  if (!value?.startsWith('enc:')) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
  } catch {
    return null;
  }
};

export const licensing = new Licensing({
  config,
  fetch: (...args) => fetch(...args),
  load: async (): Promise<Stored> => {
    try {
      const stored = JSON.parse(await readFile(file(), 'utf8')) as Stored;
      return { ...stored, code: unseal(stored.code) };
    } catch {
      return { token: null, code: null };
    }
  },
  save: async (stored) => {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(file(), JSON.stringify({ ...stored, code: seal(stored.code) }), 'utf8');
  },
  fingerprint: deviceFingerprint,
  device: () => ({ deviceName: deviceName(), platform: devicePlatform(), appVersion: app.getVersion() }),
});

let current: Access | null = null;

/** Read the kept license, answer the windows, and check in now and every few hours. */
export const registerLicensing = async (): Promise<void> => {
  current = await licensing.start();
  licensing.onChange((access) => {
    current = access;
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('vcdit:license', access);
  });

  // The preload asks once, synchronously, so the first frame already knows whether transfers may start.
  ipcMain.on('vcdit:license-now', (e) => {
    e.returnValue = current ?? licensing.access();
  });
  const guard = <T>(work: () => Promise<T>) =>
    work().catch((cause: unknown) => ({ ...licensing.access(), message: cause instanceof Error ? cause.message : String(cause) }));
  ipcMain.handle('vcdit:license-activate', (_e, code: unknown) => guard(() => licensing.activate(String(code ?? ''))));
  ipcMain.handle('vcdit:license-refresh', () => guard(() => licensing.refresh()));
  ipcMain.handle('vcdit:license-deactivate', () => guard(() => licensing.deactivate()));
  ipcMain.handle('vcdit:license-open', (_e, page: unknown) => {
    const path = page === 'pricing' ? '/pricing' : page === 'download' ? '/download' : '/account';
    return shell.openExternal(`${config.siteUrl}${path}`);
  });

  void licensing.refresh();
  setInterval(() => void licensing.refresh(), CHECK_EVERY_MS).unref?.();
};
