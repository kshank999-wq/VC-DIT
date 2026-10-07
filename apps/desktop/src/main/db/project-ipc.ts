import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import sqlWasmPath from 'sql.js/dist/sql-wasm.wasm?asset';
import type { ChecksumMethod } from '../../shared/media';
import { SCENE_STATUSES, type Production, type ProjectResult, type SceneEntry, type ShootDay } from '../../shared/project';
import { LOG_TEMPLATE, parseScriptLog } from '../scriptlog/parse';
import { Library, PRODUCTION_EXTENSION } from './library';
import type { TransferRecord } from './production-db';

/**
 * The production database wired to the app: the open production, the calls
 * the screens make to change it (window.vcdit.project), and telling the
 * windows when a different production or day is opened.
 *
 * Small edits (a name, a status) answer the caller only, so typing is never
 * overtaken by an echo; opening another production or day goes to every
 * window. Neither happens while a transfer runs: its records belong to the
 * day it started on.
 */

const CHECKSUMS: ChecksumMethod[] = ['xxHash64', 'MD5', 'SHA-1'];
const text = (value: unknown, max = 200) => (typeof value === 'string' ? value.slice(0, max) : undefined);

/** Only the fields a production has, each of the right kind. */
const productionPatch = (input: unknown): Partial<Production> => {
  const value = (input ?? {}) as Record<string, unknown>;
  const patch: Partial<Production> = {};
  if (text(value['name']) !== undefined) patch.name = text(value['name'])!;
  if (text(value['code'], 12) !== undefined) patch.code = text(value['code'], 12)!;
  if (text(value['frameRate'], 40) !== undefined) patch.frameRate = text(value['frameRate'], 40)!;
  if (CHECKSUMS.includes(value['checksum'] as ChecksumMethod)) patch.checksum = value['checksum'] as ChecksumMethod;
  if (Number.isInteger(value['totalDays']) && (value['totalDays'] as number) > 0) patch.totalDays = value['totalDays'] as number;
  if (Array.isArray(value['devices'])) {
    patch.devices = (value['devices'] as unknown[]).slice(0, 40).map((device) => {
      const d = (device ?? {}) as Record<string, unknown>;
      return { slot: text(d['slot'], 8) ?? '', name: text(d['name'], 80) ?? '', format: text(d['format'], 120) ?? '' };
    });
  }
  if (Array.isArray(value['namingTokens'])) patch.namingTokens = (value['namingTokens'] as unknown[]).slice(0, 40).map((token) => text(token, 40) ?? '');
  return patch;
};

const dayPatch = (input: unknown): Partial<Omit<ShootDay, 'number'>> => {
  const value = (input ?? {}) as Record<string, unknown>;
  const patch: Partial<Omit<ShootDay, 'number'>> = {};
  const date = text(value['date'], 10);
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) patch.date = date;
  if (text(value['locations']) !== undefined) patch.locations = text(value['locations'])!;
  const operator = value['operator'] as Record<string, unknown> | undefined;
  if (operator) patch.operator = { name: text(operator['name'], 80) ?? '', initials: text(operator['initials'], 4) ?? '' };
  return patch;
};

const scenePatch = (input: unknown): Partial<Omit<SceneEntry, 'id'>> => {
  const value = (input ?? {}) as Record<string, unknown>;
  const patch: Partial<Omit<SceneEntry, 'id'>> = {};
  if (text(value['description']) !== undefined) patch.description = text(value['description'])!;
  if (SCENE_STATUSES.includes(value['status'] as SceneEntry['status'])) patch.status = value['status'] as SceneEntry['status'];
  if (text(value['notes'], 4000) !== undefined) patch.notes = text(value['notes'], 4000)!;
  if (text(value['look']) !== undefined) patch.look = text(value['look'])!;
  return patch;
};

export interface ProjectHooks {
  /** A transfer is running: no switching productions or days. */
  busy: () => boolean;
  /** Another production or day is open: show its transfers. */
  opened: (transfers: TransferRecord[]) => void;
}

const LOG_EXTENSIONS = ['csv', 'tsv', 'txt', 'tab', 'ale', 'json', 'xml'];
const MAX_LOG_BYTES = 20 * 1024 * 1024;

export const registerProject = async (hooks: ProjectHooks): Promise<{ library: Library; changed: () => void }> => {
  const library = new Library({ dir: app.getPath('userData'), wasm: sqlWasmPath });
  await library.start();

  const broadcast = () => {
    const state = library.state();
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('vcdit:project', state);
  };
  const openedNow = () => {
    const db = library.current;
    hooks.opened(db.transfers(db.currentDay().number));
    broadcast();
  };
  const answer = async (work: () => void | Promise<void>, options: { switching?: boolean } = {}): Promise<ProjectResult> => {
    if (options.switching && hooks.busy()) return { ok: false, reason: 'A transfer is running. Wait for it to finish first.' };
    try {
      await work();
      return { ok: true, state: library.state() };
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  };

  ipcMain.on('vcdit:project-now', (e) => {
    e.returnValue = library.state();
  });
  ipcMain.handle('vcdit:project-update', (_e, patch: unknown) =>
    answer(async () => {
      const clean = productionPatch(patch);
      library.current.updateProduction(clean);
      if (clean.name !== undefined) await library.rememberAndSave();
    }),
  );
  ipcMain.handle('vcdit:project-update-day', (_e, patch: unknown) =>
    answer(() => library.current.updateDay(library.current.currentDay().number, dayPatch(patch))),
  );
  ipcMain.handle('vcdit:project-add-scene', (_e, scene: unknown) =>
    answer(() => {
      const value = (scene ?? {}) as Record<string, unknown>;
      const id = text(value['id'], 12) ?? '';
      if (!library.current.addScene(library.current.currentDay().number, { id, ...scenePatch(value) })) throw new Error('That scene is already on the list.');
    }),
  );
  ipcMain.handle('vcdit:project-update-scene', (_e, id: unknown, patch: unknown) =>
    answer(() => library.current.updateScene(library.current.currentDay().number, String(id), scenePatch(patch))),
  );
  ipcMain.handle('vcdit:project-remove-scene', (_e, id: unknown) => answer(() => library.current.removeScene(library.current.currentDay().number, String(id))));

  ipcMain.handle('vcdit:project-add-day', async () => {
    const result = await answer(() => void library.current.addDay(), { switching: true });
    if (result.ok) openedNow();
    return result;
  });
  ipcMain.handle('vcdit:project-open-day', async (_e, number: unknown) => {
    const result = await answer(() => library.current.openDay(Number(number)), { switching: true });
    if (result.ok) openedNow();
    return result;
  });
  ipcMain.handle('vcdit:project-new', async () => {
    const result = await answer(async () => void (await library.create({})), { switching: true });
    if (result.ok) openedNow();
    return result;
  });
  ipcMain.handle('vcdit:project-open', async (e, file: unknown) => {
    if (hooks.busy()) return { ok: false, reason: 'A transfer is running. Wait for it to finish first.' };
    let path = typeof file === 'string' && library.state().recent.some((item) => item.file === file) ? file : null;
    if (!path) {
      const window = BrowserWindow.fromWebContents(e.sender);
      const options = {
        title: 'Open a production',
        properties: ['openFile'] as 'openFile'[],
        filters: [{ name: 'VC DIT production', extensions: [PRODUCTION_EXTENSION] }],
      };
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, reason: '' };
      path = picked.filePaths[0];
    }
    const result = await answer(async () => void (await library.open(path!)), { switching: true });
    if (result.ok) openedNow();
    return result;
  });
  ipcMain.handle('vcdit:project-save-copy', async (e) => {
    const db = library.current;
    const window = BrowserWindow.fromWebContents(e.sender);
    const options = {
      title: 'Save a copy of this production',
      defaultPath: `${db.production().name.replace(/[\\/:*?"<>|]+/g, '_') || 'Production'}.${PRODUCTION_EXTENSION}`,
      filters: [{ name: 'VC DIT production', extensions: [PRODUCTION_EXTENSION] }],
    };
    const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, reason: '' };
    return answer(() => db.saveCopy(picked.filePath!));
  });
  ipcMain.handle('vcdit:project-reveal', () => shell.showItemInFolder(library.current.file));

  // ------------------------------------------------ the script supervisor's log
  ipcMain.handle('vcdit:project-import-log', async (e) => {
    const window = BrowserWindow.fromWebContents(e.sender);
    const options = {
      title: "Import the script supervisor's log",
      properties: ['openFile'] as 'openFile'[],
      filters: [{ name: 'Script supervisor log', extensions: LOG_EXTENSIONS }],
    };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, reason: '' };
    const path = picked.filePaths[0];
    return answer(async () => {
      if ((await stat(path)).size > MAX_LOG_BYTES) throw new Error('That file is too large to be a script supervisor log.');
      const parsed = parseScriptLog(basename(path), await readFile(path));
      const db = library.current;
      db.importLog(db.currentDay().number, basename(path), parsed);
    });
  });
  ipcMain.handle('vcdit:project-resolve-match', (_e, id: unknown, clip: unknown) =>
    answer(() => library.current.resolveMatch(library.current.currentDay().number, String(id), typeof clip === 'string' ? clip : null)),
  );
  ipcMain.handle('vcdit:project-save-log-template', async (e) => {
    const window = BrowserWindow.fromWebContents(e.sender);
    const options = { title: 'Save the log template', defaultPath: 'VC DIT script log template.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] };
    const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, reason: '' };
    return answer(() => writeFile(picked.filePath!, LOG_TEMPLATE, 'utf8'));
  });

  return { library, changed: broadcast };
};
