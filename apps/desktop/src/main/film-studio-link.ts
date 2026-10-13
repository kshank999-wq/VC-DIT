import { app, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILM_STUDIO_URL, keyHint, readKey, uploadEndpoint, cameraReportEndpoint } from './reports/film-studio-send';

/**
 * Which VC Film Studio production each production on this cart sends its day
 * to: the upload key made on that production's data desk.
 *
 * ON THIS COMPUTER, NOT IN THE PRODUCTION FILE. A .vcdit file travels — onto
 * the RAID, a shuttle drive, a colleague's cart — and a key inside it would
 * travel with it. So the key is kept beside the license, in the app's own
 * folder, sealed by the operating system's keychain where there is one
 * (safeStorage), and is never sent back to the screens: they are told only
 * whether there is one and its last four characters.
 *
 * Keyed by the production's file. Opening a copy of the production from
 * somewhere else asks for the key again, which is the safe way round.
 *
 * The site comes from the build (MAIN_VITE_FILM_STUDIO_URL), so a test build
 * can point at a preview deployment; a release sends to vcfilmstudio.com.
 */

const site = (import.meta.env.MAIN_VITE_FILM_STUDIO_URL || FILM_STUDIO_URL).replace(/\/+$/, '');
export const filmStudioEndpoint = uploadEndpoint(site);
export const filmStudioReportEndpoint = cameraReportEndpoint(site);

const file = () => join(app.getPath('userData'), 'film-studio.json');

const seal = (value: string): string =>
  safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(value).toString('base64')}` : value;
const unseal = (value: string): string | null => {
  if (!value.startsWith('enc:')) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
  } catch {
    // Sealed on another login or machine: as good as no key.
    return null;
  }
};

type Kept = { keys: Record<string, string> };

const load = async (): Promise<Kept> => {
  try {
    const kept = JSON.parse(await readFile(file(), 'utf8')) as Partial<Kept>;
    return { keys: kept.keys && typeof kept.keys === 'object' ? kept.keys : {} };
  } catch {
    return { keys: {} };
  }
};
const save = async (kept: Kept) => {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(file(), JSON.stringify(kept), 'utf8');
};

export interface FilmStudioLink {
  linked: boolean;
  /** "vcdit_…x9Qa", or null. */
  hint: string | null;
  endpoint: string;
}

/** The key for this production, for the main process only. */
export const filmStudioKey = async (production: string): Promise<string | null> => {
  const sealed = (await load()).keys[production];
  return sealed ? unseal(sealed) : null;
};

export const filmStudioLink = async (production: string): Promise<FilmStudioLink> => {
  const key = await filmStudioKey(production);
  return { linked: !!key, hint: key ? keyHint(key) : null, endpoint: filmStudioEndpoint };
};

export const setFilmStudioKey = async (
  production: string,
  input: unknown,
): Promise<{ ok: true; link: FilmStudioLink } | { ok: false; reason: string }> => {
  const read = readKey(typeof input === 'string' ? input.slice(0, 400) : '');
  if (!read.ok) return read;
  const kept = await load();
  kept.keys[production] = seal(read.key);
  await save(kept);
  return { ok: true, link: await filmStudioLink(production) };
};

export const clearFilmStudioKey = async (production: string): Promise<FilmStudioLink> => {
  const kept = await load();
  delete kept.keys[production];
  await save(kept);
  return filmStudioLink(production);
};
