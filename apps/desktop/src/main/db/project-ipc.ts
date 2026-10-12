import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ChecksumMethod, SealResult } from '../../shared/media';
import { DeliveryService, manifestCsv, type RunTransfer } from '../delivery/delivery-service';
import { OrganizeService } from '../organize/organize-service';
import { dayEntries, dayReportHtml } from '../reports/day-report';
import { filmStudioDay } from '../reports/film-studio';
import { fetchCameraReport, pullNote, sendDay } from '../reports/film-studio-send';
import { clearFilmStudioKey, filmStudioEndpoint, filmStudioKey, filmStudioLink, filmStudioReportEndpoint, setFilmStudioKey } from '../film-studio-link';
import { Thumbnails } from '../thumbs/thumbnails';
import { sealDrive, type SealProgress } from '../media/seal';
import { segment } from '../media/rules';
import { DEFAULT_DAILIES, DELIVERY_PACKAGES, FORMAT_RULES, LUT_SCOPES, MIRROR_METHODS, SCENE_STATUSES, type DailiesSettings, type DayNote, type DeliveryPackageId, type CameraReportInput, type DeliverySettings, type FormatRule, type SlateInput, type LutScope, type MirrorMethod, type Production, type ProjectResult, type ProjectState, type SceneEntry, type ShootDay } from '../../shared/project';
import { DailiesService } from '../dailies/dailies-service';
import { AUDIO, CODECS, RESOLUTIONS } from '../dailies/render-args';
import { locateFfmpeg, type Ffmpeg } from '../ffmpeg/ffmpeg';
import transferWorkerPath from '../media/transfer-worker?modulePath';
import type { WorkerMessage, WorkerPlan } from '../media/transfer-worker';
import analysisWorkerPath from '../sync/analysis-worker?modulePath';
import type { AnalysisMessage } from '../sync/analysis-worker';
import { SyncService, type RunAnalysis } from '../sync/sync-service';
import type { RunCopy } from '../vfx/mirror';
import { VfxService } from '../vfx/vfx-service';
import { LOG_TEMPLATE, parseScriptLog } from '../scriptlog/parse';
import { REPORT_TEMPLATE } from '../organize/assign';
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

/** SQLite's WebAssembly, from the installed sql.js (a runtime dependency: inside the app archive when packaged). */
const sqlWasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');

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
  if (MIRROR_METHODS.includes(value['vfxMethod'] as MirrorMethod)) patch.vfxMethod = value['vfxMethod'] as MirrorMethod;
  if (FORMAT_RULES.includes(value['formatRule'] as FormatRule)) patch.formatRule = value['formatRule'] as FormatRule;
  if (typeof value['renameClips'] === 'boolean') patch.renameClips = value['renameClips'];
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

/** Only the settings a dailies run has, each of the right kind. */
const dailiesSettings = (input: unknown): DailiesSettings => {
  const value = (input ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(options: readonly T[], given: unknown, fallback: T): T => (options.includes(given as T) ? (given as T) : fallback);
  const burnIns = (value['burnIns'] ?? {}) as Record<string, unknown>;
  return {
    include: pick(['circle', 'all', 'scene'] as const, value['include'], DEFAULT_DAILIES.include),
    scenes: Array.isArray(value['scenes']) ? value['scenes'].map((scene) => String(scene).slice(0, 12)).slice(0, 500) : [],
    codec: pick(CODECS, value['codec'], DEFAULT_DAILIES.codec),
    resolution: pick(RESOLUTIONS, value['resolution'], DEFAULT_DAILIES.resolution),
    audio: pick(AUDIO, value['audio'], DEFAULT_DAILIES.audio),
    look: pick(['Per assignment rules', 'Project default only', 'None · LOG original'] as const, value['look'], DEFAULT_DAILIES.look),
    grouping: pick(['Scene → Setup → Take', 'Camera roll', 'Shoot order'] as const, value['grouping'], DEFAULT_DAILIES.grouping),
    destination: typeof value['destination'] === 'string' ? value['destination'].slice(0, 4096) : '',
    burnIns: Object.fromEntries(Object.keys(DEFAULT_DAILIES.burnIns).map((key) => [key, burnIns[key] === true])),
  };
};

export interface ProjectHooks {
  /** A transfer is running: no switching productions or days. */
  busy: () => boolean;
  /** Another production or day is open: show its transfers. */
  opened: (transfers: TransferRecord[]) => void;
  /** Where copies may go now: destination volumes and folders, by id. */
  destinations: () => { id: string; name: string; kind: string; root: string }[];
  /** Keep a destination from copies and ejecting while it is sealed. */
  hold: (id: string, why: string) => { ok: true; root: string; name: string; release: () => void } | { ok: false; reason: string };
}

const LOG_EXTENSIONS = ['csv', 'tsv', 'txt', 'tab', 'ale', 'json', 'xml'];
const MAX_LOG_BYTES = 20 * 1024 * 1024;

/** A verified copy in the transfer worker, like an ingest: VFX physical copies and deliveries. */
const runTransferJob: RunTransfer = (plan: WorkerPlan, options = {}) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(transferWorkerPath, { workerData: plan });
    const stop = () => worker.postMessage('stop');
    options.signal?.addEventListener('abort', stop, { once: true });
    const settle = () => options.signal?.removeEventListener('abort', stop);
    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'progress') options.onProgress?.(message.progress);
      else if (message.type === 'done') {
        settle();
        resolve({ result: message.result, reports: message.reports });
      } else {
        settle();
        reject(new Error(message.message));
      }
    });
    worker.on('error', (cause) => {
      settle();
      reject(cause);
    });
    worker.on('exit', (code) => {
      settle();
      if (code !== 0) reject(new Error('The copy stopped unexpectedly.'));
    });
  });
const runCopy: RunCopy = (plan) => runTransferJob(plan);

/** Only the delivery choices there are; the folders change only through their own calls. */
const deliverySettings = (input: unknown, current: DeliverySettings): DeliverySettings => {
  const value = (input ?? {}) as Record<string, unknown>;
  const ids = DELIVERY_PACKAGES.map((pkg) => pkg.id);
  const packages = (given: unknown): DeliveryPackageId[] => (Array.isArray(given) ? ids.filter((id) => given.includes(id)) : []);
  const places = (given: unknown): string[] => (Array.isArray(given) ? [...new Set(given.filter((id): id is string => typeof id === 'string').map((id) => id.slice(0, 4096)))].slice(0, 50) : []);
  return {
    packages: 'packages' in value ? packages(value['packages']) : current.packages,
    destinations: 'destinations' in value ? places(value['destinations']) : current.destinations,
    folders: current.folders,
    presets: Array.isArray(value['presets'])
      ? (value['presets'] as unknown[]).slice(0, 30).map((preset) => {
          const p = (preset ?? {}) as Record<string, unknown>;
          return { name: text(p['name'], 60) ?? 'Preset', packages: packages(p['packages']), destinations: places(p['destinations']) };
        })
      : current.presets,
  };
};

/** A page of HTML as a PDF, through a hidden window that runs no scripts. */
const htmlToPdf = async (page: string): Promise<Buffer> => {
  const dir = await mkdtemp(join(tmpdir(), 'vcdit-report-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await writeFile(join(dir, 'report.html'), page, 'utf8');
    await window.loadFile(join(dir, 'report.html'));
    return await window.webContents.printToPDF({ landscape: true, pageSize: 'A4', printBackground: true });
  } finally {
    window.destroy();
    await rm(dir, { recursive: true, force: true });
  }
};

/** Sync's reading and comparing, in its own worker: one per batch of jobs. */
const runAnalysis: RunAnalysis = (jobs) =>
  new Promise((resolve, reject) => {
    const results: unknown[] = [];
    const worker = new Worker(analysisWorkerPath, { workerData: jobs });
    worker.on('message', (message: AnalysisMessage) => {
      if (message.type === 'result') results[message.index] = message.value;
      else if (message.type === 'done') resolve(results);
      else reject(new Error(message.message));
    });
    worker.on('error', reject);
    worker.on('exit', (code) => code !== 0 && reject(new Error('Sync stopped unexpectedly.')));
  });

export interface Project {
  library: Library;
  vfx: VfxService;
  sync: SyncService;
  dailies: DailiesService;
  delivery: DeliveryService;
  organize: OrganizeService;
  /** Tell the windows the production changed. */
  changed: () => void;
  /** A card finished: match the log again, then mirror any VFX shot it completes. */
  cardIn: (day: number) => void;
}

export const registerProject = async (hooks: ProjectHooks): Promise<Project> => {
  const library = new Library({ dir: app.getPath('userData'), wasm: sqlWasmPath });
  await library.start();

  let vfx: VfxService | null = null;
  let sync: SyncService | null = null;
  let dailies: DailiesService | null = null;
  let delivery: DeliveryService | null = null;
  let organizer: OrganizeService | null = null;
  // FFmpeg and the burn-in font ship as resources; in development they are in build/ (or FFmpeg on the PATH).
  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'build');
  let ffmpegFound: Ffmpeg | null = null;
  const ffmpegReady = locateFfmpeg(resources).then((found) => (ffmpegFound = found));
  const baseState = (): ProjectState => ({
    ...library.state(),
    vfxActivity: vfx?.activity ?? null,
    syncActivity: sync?.activity ?? null,
    dailiesActivity: dailies?.activity ?? null,
    ffmpeg: ffmpegFound ? { version: ffmpegFound.version } : null,
  });
  const stateNow = (): ProjectState => {
    const state = baseState();
    return {
      ...state,
      ...(delivery ? { delivery: { ...state.delivery, ...delivery.view() } } : {}),
      ...(organizer ? { organize: organizer.view() } : {}),
    };
  };
  const broadcast = () => {
    const state = stateNow();
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('vcdit:project', state);
  };
  vfx = new VfxService({ db: () => library.current, runCopy, tool: { name: 'VC DIT', version: app.getVersion() }, changed: broadcast });
  const mirrors = vfx;
  sync = new SyncService({ db: () => library.current, runAnalysis, changed: broadcast });
  const syncing = sync;
  /** Read new files' timecode and sync what timecode can; quick, so it follows every change. */
  const syncQuick = () => void syncing.run({ waveform: false });
  organizer = new OrganizeService({ db: () => library.current, changed: broadcast });
  const organizing = organizer;
  /** Make the quick mirrors (links, references) for anything newly flagged, matched or verified, and keep the scene folders in step. */
  const mirrorQuick = () => {
    void mirrors.run({ copies: false, retry: false });
    void organizing.run();
  };
  dailies = new DailiesService({
    db: () => library.current,
    ffmpeg: () => ffmpegReady,
    font: join(resources, 'fonts', 'IBMPlexMono-Medium.ttf'),
    destination: (id) => hooks.destinations().find((destination) => destination.id === id) ?? null,
    changed: broadcast,
  });
  const rendering = dailies;
  void ffmpegReady.then(broadcast);
  delivery = new DeliveryService({
    db: () => library.current,
    places: () => hooks.destinations(),
    runTransfer: runTransferJob,
    tool: { name: 'VC DIT', version: app.getVersion() },
    changed: broadcast,
  });
  const delivering = delivery;
  const busy = () => hooks.busy() || mirrors.activity !== null || syncing.activity !== null || rendering.busy() || delivering.busy();

  const openedNow = () => {
    const db = library.current;
    hooks.opened(db.transfers(db.currentDay().number));
    broadcast();
    mirrorQuick();
    syncQuick();
  };
  const answer = async (work: () => void | Promise<void>, options: { switching?: boolean } = {}): Promise<ProjectResult> => {
    if (options.switching && busy()) return { ok: false, reason: 'A transfer or VFX copy is running. Wait for it to finish first.' };
    try {
      await work();
      return { ok: true, state: stateNow() };
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  };

  ipcMain.on('vcdit:project-now', (e) => {
    e.returnValue = stateNow();
  });
  ipcMain.handle('vcdit:project-update', (_e, patch: unknown) =>
    answer(async () => {
      const clean = productionPatch(patch);
      library.current.updateProduction(clean);
      if (clean.name !== undefined) await library.rememberAndSave();
      if (clean.vfxMethod !== undefined) mirrorQuick();
      // The take folders are named by the template and the production code.
      if (clean.namingTokens !== undefined || clean.code !== undefined) void organizing.run();
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
      mirrorQuick();
      syncQuick();
    });
  });
  ipcMain.handle('vcdit:project-resolve-match', (_e, id: unknown, clip: unknown) =>
    answer(() => {
      library.current.resolveMatch(library.current.currentDay().number, String(id), typeof clip === 'string' ? clip : null);
      mirrorQuick();
    }),
  );
  // ------------------------------------------------ takes: the camera report and the DIT's own assignments
  const reportRow = (input: unknown): CameraReportInput => {
    const value = (input ?? {}) as Record<string, unknown>;
    return {
      card: (text(value['card'], 24) ?? '').toUpperCase(),
      clip: text(value['clip'], 60) ?? '',
      scene: (text(value['scene'], 12) ?? '').toUpperCase(),
      setup: (text(value['setup'], 8) ?? '').toUpperCase(),
      take: text(value['take'], 6) ?? '',
      circle: value['circle'] === true,
      lens: text(value['lens'], 40) ?? '',
      notes: text(value['notes'], 400) ?? '',
    };
  };
  ipcMain.handle('vcdit:project-camera-report', (_e, card: unknown, rows: unknown) =>
    answer(() => {
      const name = (text(card, 24) ?? '').toUpperCase();
      if (!name) throw new Error('Name the card or roll this report is for.');
      const clean = (Array.isArray(rows) ? rows.slice(0, 2000) : []).map(reportRow).filter((row) => row.clip && row.scene && row.take);
      library.current.setCameraReport(library.current.currentDay().number, name, clean);
      mirrorQuick();
    }),
  );
  ipcMain.handle('vcdit:project-import-camera-report', async (e) => {
    const window = BrowserWindow.fromWebContents(e.sender);
    const options = { title: 'Import a camera report', properties: ['openFile'] as 'openFile'[], filters: [{ name: 'Camera report', extensions: LOG_EXTENSIONS }] };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, reason: '' };
    const path = picked.filePaths[0];
    return answer(async () => {
      if ((await stat(path)).size > MAX_LOG_BYTES) throw new Error('That file is too large to be a camera report.');
      const parsed = parseScriptLog(basename(path), await readFile(path));
      const db = library.current;
      const result = db.importCameraReport(db.currentDay().number, parsed.entries);
      if (result.rows === 0) throw new Error(`No rows with a card or roll, a clip, a scene and a take were found in ${basename(path)}.`);
      mirrorQuick();
    });
  });
  /**
   * The day's camera report from VC Film Studio, as the AC entered it there.
   * Rolls typed here or imported from a file stay as they are; the note says
   * which, so nobody wonders why Film Studio's lines did not appear.
   */
  ipcMain.handle('vcdit:project-pull-camera-report', async (): Promise<ProjectResult> => {
    const db = library.current;
    const day = db.currentDay();
    const key = await filmStudioKey(db.file);
    if (!key) return { ok: false, reason: 'This production has no Film Studio upload key yet. Paste one in Project setup → VC Film Studio.' };
    const pulled = await fetchCameraReport({ fetch: (...args) => fetch(...args), endpoint: filmStudioReportEndpoint, key, date: day.date, day: day.number });
    if (!pulled.ok) return pulled;
    try {
      const result = db.pullCameraReport(day.number, pulled.lines);
      mirrorQuick();
      return { ok: true, state: stateNow(), note: pullNote(pulled.lines.length, result) };
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  });
  ipcMain.handle('vcdit:project-save-report-template', async (e) => {
    const window = BrowserWindow.fromWebContents(e.sender);
    const options = { title: 'Save the camera report template', defaultPath: 'VC DIT camera report template.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] };
    const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, reason: '' };
    return answer(() => writeFile(picked.filePath!, REPORT_TEMPLATE, 'utf8'));
  });
  ipcMain.handle('vcdit:project-assign', (_e, clips: unknown, slate: unknown) =>
    answer(() => {
      const list = (Array.isArray(clips) ? clips.slice(0, 5000) : [])
        .map((item) => (item ?? {}) as Record<string, unknown>)
        .map((item) => ({ card: text(item['card'], 24) ?? '', clip: text(item['clip'], 60) ?? '' }))
        .filter((item) => item.card && item.clip);
      let clean: SlateInput | null = null;
      if (slate) {
        const value = slate as Record<string, unknown>;
        clean = {
          scene: text(value['scene'], 12) ?? '',
          setup: text(value['setup'], 8) ?? '',
          take: text(value['take'], 6) ?? '',
          circle: value['circle'] === true,
        };
        if (!clean.scene || !clean.take) throw new Error('A scene and a take are needed.');
      }
      library.current.assignClips(library.current.currentDay().number, list, clean);
      mirrorQuick();
    }),
  );

  ipcMain.handle('vcdit:project-save-log-template', async (e) => {
    const window = BrowserWindow.fromWebContents(e.sender);
    const options = { title: 'Save the log template', defaultPath: 'VC DIT script log template.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] };
    const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, reason: '' };
    return answer(() => writeFile(picked.filePath!, LOG_TEMPLATE, 'utf8'));
  });

  // ------------------------------------------------ VFX
  ipcMain.handle('vcdit:project-vfx-tag', (_e, clip: unknown, note: unknown) =>
    answer(() => {
      library.current.tagVfx(library.current.currentDay().number, text(clip, 40) ?? '', text(note, 400) ?? '');
      mirrorQuick();
    }),
  );
  // Copies can take a while: this starts them, and the windows follow along.
  ipcMain.handle('vcdit:project-vfx-mirror', () => answer(() => void mirrors.run({ copies: true, retry: true })));
  ipcMain.handle('vcdit:project-vfx-send', () =>
    answer(async () => {
      if ((await mirrors.sendToPrep()) === 0) throw new Error('No shot is ready: each needs its clip matched and mirrored first.');
    }),
  );

  // ------------------------------------------------ sync
  const day = () => library.current.currentDay().number;
  ipcMain.handle('vcdit:project-sync-waveform', () => answer(() => void syncing.run({ waveform: true })));
  ipcMain.handle('vcdit:project-sync-nudge', (_e, id: unknown, frames: unknown) =>
    answer(() => library.current.nudgeSync(day(), String(id), Math.max(-500, Math.min(500, Math.round(Number(frames) || 0))))),
  );
  ipcMain.handle('vcdit:project-sync-accept', (_e, ids: unknown) =>
    answer(() => library.current.acceptSync(day(), Array.isArray(ids) ? ids.map(String).slice(0, 5000) : [])),
  );

  // ------------------------------------------------ looks
  ipcMain.handle('vcdit:project-lut-import', async (e) => {
    const window = BrowserWindow.fromWebContents(e.sender);
    const options = {
      title: 'Import LUTs',
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
      filters: [{ name: 'LUT or ASC CDL', extensions: ['cube', '3dl', 'cc', 'ccc', 'cdl'] }],
    };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, reason: '' };
    return answer(async () => {
      const problems: string[] = [];
      for (const path of picked.filePaths.slice(0, 50)) {
        try {
          if ((await stat(path)).size > 64 * 1024 * 1024) throw new Error('too large to be a LUT');
          library.current.importLut(basename(path), await readFile(path, 'utf8'));
        } catch (cause) {
          problems.push(`${basename(path)}: ${(cause as Error).message}`);
        }
      }
      if (problems.length) throw new Error(problems.join(' '));
    });
  });
  ipcMain.handle('vcdit:project-lut-remove', (_e, id: unknown) => answer(() => library.current.removeLut(Number(id))));
  ipcMain.handle('vcdit:project-lut-rule', (_e, scope: unknown, target: unknown, lutId: unknown) =>
    answer(() => {
      if (!LUT_SCOPES.includes(scope as LutScope)) throw new Error('Unknown rule scope.');
      library.current.setLutRule(scope as LutScope, text(target, 40) ?? '', Number(lutId));
    }),
  );
  ipcMain.handle('vcdit:project-lut-rule-remove', (_e, id: unknown) => answer(() => library.current.removeLutRule(Number(id))));
  const thumbnails = new Thumbnails({ db: () => library.current, ffmpeg: () => ffmpegReady, dir: join(app.getPath('userData'), 'thumbnails') });
  ipcMain.handle('vcdit:project-thumbnail', async (_e, clip: unknown, options: unknown) => {
    const value = (options ?? {}) as Record<string, unknown>;
    try {
      return { ok: true, url: await thumbnails.get(String(clip).slice(0, 200), { look: value['look'] === true, size: value['size'] === 'large' ? 'large' : 'small' }) };
    } catch (cause) {
      return { ok: false, reason: (cause as Error).message };
    }
  });
  ipcMain.handle('vcdit:project-look-preview', async (_e, clipId: unknown, lutId: unknown) => {
    try {
      return { ok: true, ...(await rendering.preview(String(clipId), lutId === null ? null : Number(lutId))) };
    } catch (cause) {
      return { ok: false, reason: (cause as Error).message };
    }
  });

  // ------------------------------------------------ dailies
  ipcMain.handle('vcdit:project-dailies-settings', (_e, settings: unknown) => answer(() => library.current.saveDailiesSettings(dailiesSettings(settings))));
  ipcMain.handle('vcdit:project-dailies-start', (_e, settings: unknown) => answer(async () => void (await rendering.start(dailiesSettings(settings)))));
  ipcMain.handle('vcdit:project-dailies-stop', () => answer(() => rendering.stop()));
  ipcMain.handle('vcdit:project-dailies-show', (_e, path: unknown) => {
    // Only files VC DIT rendered.
    const db = library.current;
    if (db.renders(db.currentDay().number).some((render) => render.output === path)) shell.showItemInFolder(String(path));
  });

  // ------------------------------------------------ delivery
  const settingsNow = () => library.current.deliverySettings();
  ipcMain.handle('vcdit:project-delivery-settings', (_e, settings: unknown) =>
    answer(() => library.current.saveDeliverySettings(deliverySettings(settings, settingsNow()))),
  );
  ipcMain.handle('vcdit:project-delivery-refresh', () => answer(() => void delivering.refresh()));
  ipcMain.handle('vcdit:project-delivery-start', () =>
    answer(async () => {
      if (hooks.busy()) throw new Error('A card is still being copied. Deliver when it has finished, so the delivery is complete.');
      if (rendering.busy()) throw new Error('Dailies are rendering. Deliver when they have finished.');
      if (mirrors.activity !== null) throw new Error('VFX shots are being mirrored. Deliver when that has finished.');
      await delivering.start();
    }),
  );
  ipcMain.handle('vcdit:project-delivery-stop', () => answer(() => delivering.stop()));
  ipcMain.handle('vcdit:project-delivery-retry', (_e, pkg: unknown, destination: unknown) =>
    answer(async () => {
      if (!DELIVERY_PACKAGES.some((candidate) => candidate.id === pkg)) throw new Error('Unknown package.');
      await delivering.retry(pkg as DeliveryPackageId, String(destination));
    }),
  );
  ipcMain.handle('vcdit:project-delivery-add-folder', async (e) => {
    const window = BrowserWindow.fromWebContents(e.sender);
    const options = { title: 'Deliver to a folder', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, reason: '' };
    const path = picked.filePaths[0];
    return answer(() => {
      const current = settingsNow();
      if (current.folders.some((folder) => folder.path === path)) return;
      const folder = { id: `delivery-folder:${randomUUID()}`, name: basename(path) || path, path };
      library.current.saveDeliverySettings({ ...current, folders: [...current.folders, folder], destinations: [...current.destinations, folder.id] });
      void delivering.refresh();
    });
  });
  ipcMain.handle('vcdit:project-delivery-remove-folder', (_e, id: unknown) =>
    answer(() => {
      const current = settingsNow();
      library.current.saveDeliverySettings({
        ...current,
        folders: current.folders.filter((folder) => folder.id !== id),
        destinations: current.destinations.filter((destination) => destination !== id),
      });
      void delivering.refresh();
    }),
  );
  ipcMain.handle('vcdit:project-delivery-save-manifest', async (e) => {
    const db = library.current;
    const day = db.currentDay();
    const window = BrowserWindow.fromWebContents(e.sender);
    const options = {
      title: 'Save the delivery manifest',
      defaultPath: `${db.production().code || 'VC DIT'} Day ${String(day.number).padStart(3, '0')} delivery manifest.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    };
    const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, reason: '' };
    return answer(() => writeFile(picked.filePath!, manifestCsv(db.deliveries(day.number)), 'utf8'));
  });
  // ------------------------------------------------ the day's notes
  const NOTE_SOURCES: DayNote['tcSource'][] = ['ltc', 'free-run', 'jam', 'clock', 'none'];
  /** What a note says and is about, each of the right kind. */
  const noteAbout = (value: Record<string, unknown>) => ({
    scope: value['scope'] === 'shot' ? ('shot' as const) : ('general' as const),
    scene: text(value['scene'], 12) ?? '',
    setup: text(value['setup'], 12) ?? '',
    take: text(value['take'], 12) ?? '',
    clip: text(value['clip'], 60) ?? '',
  });
  ipcMain.handle('vcdit:project-note-add', (_e, input: unknown) =>
    answer(() => {
      const value = (input ?? {}) as Record<string, unknown>;
      const body = (text(value['text'], 8000) ?? '').trim();
      if (!body) throw new Error('Write the note first.');
      const tc = text(value['tc'], 16);
      library.current.addNote(library.current.currentDay().number, {
        tc: tc && /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(tc) ? tc : null,
        tcSource: tc && NOTE_SOURCES.includes(value['tcSource'] as DayNote['tcSource']) ? (value['tcSource'] as DayNote['tcSource']) : 'none',
        rate: text(value['rate'], 12) ?? '',
        at: new Date().toISOString(),
        ...noteAbout(value),
        text: body,
        screen: text(value['screen'], 24) ?? '',
      });
    }),
  );
  ipcMain.handle('vcdit:project-note-update', (_e, id: unknown, patch: unknown) =>
    answer(() => {
      const value = (patch ?? {}) as Record<string, unknown>;
      const body = text(value['text'], 8000)?.trim();
      if (body === '') throw new Error('A note cannot be empty. Delete it instead.');
      library.current.updateNote(library.current.currentDay().number, Number(id), { ...noteAbout(value), ...(body !== undefined ? { text: body } : {}) });
    }),
  );
  ipcMain.handle('vcdit:project-note-remove', (_e, id: unknown) => answer(() => library.current.removeNote(library.current.currentDay().number, Number(id))));

  // ------------------------------------------------ reports
  let shown = new Set<string>();
  const pdfs = new Set<string>();
  const reportsNow = async () => {
    const db = library.current;
    const entries = await dayEntries(db, db.currentDay().number, organizing.view());
    shown = new Set([...entries.flatMap((entry) => entry.files), ...pdfs]);
    return entries;
  };
  ipcMain.handle('vcdit:project-reports', async () => {
    try {
      return await reportsNow();
    } catch {
      return [];
    }
  });
  ipcMain.handle('vcdit:project-report-show', async (_e, path: unknown) => {
    // Only report files the list named.
    if (typeof path !== 'string' || !shown.has(path)) return;
    if ((await stat(path).catch(() => null))?.isDirectory()) void shell.openPath(path);
    else shell.showItemInFolder(path);
  });
  /** The day report as a PDF: saved where the DIT chooses, or into REPORTS/day_report on every drive holding the day. */
  /** Files written for a day into REPORTS/<folder> on every connected drive holding it. */
  const writeToDrives = async (dayNumber: number, folder: string, files: { name: string; body: Buffer | string }[]) => {
    const db = library.current;
    const days = [...new Set(db.transfers(dayNumber).flatMap((transfer) => transfer.destinations.map((leg) => dirname(dirname(leg.targetDir)))))];
    const written: string[] = [];
    for (const dir of days) {
      if (!(await stat(dir).catch(() => null))) continue;
      await mkdir(join(dir, 'REPORTS', folder), { recursive: true });
      for (const file of files) await writeFile(join(dir, 'REPORTS', folder, file.name), file.body);
      written.push(join(dir, 'REPORTS', folder, files[0]!.name));
    }
    return written;
  };
  const fileStamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').replace('T', '_');
  const dayName = (suffix: string) => {
    const db = library.current;
    return `${(db.production().code || db.production().name || 'VCDIT').replace(/[^\w.-]+/g, '_')}_D${String(db.currentDay().number).padStart(3, '0')}_${suffix}`;
  };
  const remember = (paths: string[]) => {
    for (const path of paths) {
      pdfs.add(path);
      shown.add(path);
    }
  };
  const dayReportPdf = async () => {
    const db = library.current;
    return htmlToPdf(dayReportHtml(db, db.currentDay().number, await reportsNow(), { name: 'VC DIT', version: app.getVersion() }));
  };

  /** The day report as a PDF: saved where the DIT chooses, or into REPORTS/day_report on every drive holding the day. */
  ipcMain.handle('vcdit:project-day-report', async (e, where: unknown) => {
    try {
      const name = dayName('REPORT');
      const pdf = await dayReportPdf();
      if (where === 'drives') {
        const written = await writeToDrives(library.current.currentDay().number, 'day_report', [{ name: `${name}_${fileStamp()}.pdf`, body: pdf }]);
        if (written.length === 0) return { ok: false, reason: 'No drive holding this day is connected. Save the report somewhere instead.' };
        remember(written);
        return { ok: true, written };
      }
      const window = BrowserWindow.fromWebContents(e.sender);
      const options = { title: 'Save the day report', defaultPath: `${name}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] };
      const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { ok: false, reason: '' };
      await writeFile(picked.filePath, pdf);
      remember([picked.filePath]);
      return { ok: true, written: [picked.filePath] };
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  /**
   * The day's DIT log for VC Film Studio (JSON): saved with the day report PDF
   * beside it, written to the drives, or sent straight to the production in
   * Film Studio with its upload key.
   */
  ipcMain.handle('vcdit:project-film-studio', async (e, where: unknown) => {
    try {
      const db = library.current;
      const day = db.currentDay().number;
      const log = `${JSON.stringify(filmStudioDay(db, day, await reportsNow(), { name: 'VC DIT', version: app.getVersion() }), null, 2)}\n`;
      if (where === 'send') {
        const key = await filmStudioKey(db.file);
        if (!key) return { ok: false, reason: 'This production has no Film Studio upload key yet. Paste one in Project setup → VC Film Studio.' };
        // No PDF: Film Studio reads the log. The PDF is for people, and "Write to drives" puts it where they look.
        return await sendDay({ fetch: (...args) => fetch(...args), endpoint: filmStudioEndpoint, key, log });
      }
      const pdf = await dayReportPdf();
      if (where === 'drives') {
        const base = `${dayName('VC_FILM_STUDIO')}_${fileStamp()}`;
        const written = await writeToDrives(day, 'vc_film_studio', [
          { name: `${base}.json`, body: log },
          { name: `${base}.pdf`, body: pdf },
        ]);
        if (written.length === 0) return { ok: false, reason: 'No drive holding this day is connected. Save the log somewhere instead.' };
        remember(written);
        return { ok: true, written };
      }
      const window = BrowserWindow.fromWebContents(e.sender);
      const options = { title: 'Export the day for VC Film Studio', defaultPath: `${dayName('VC_FILM_STUDIO')}.json`, filters: [{ name: 'VC Film Studio DIT log', extensions: ['json'] }] };
      const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { ok: false, reason: '' };
      await writeFile(picked.filePath, log, 'utf8');
      await writeFile(picked.filePath.replace(/\.json$/i, '') + '.pdf', pdf);
      remember([picked.filePath]);
      return { ok: true, written: [picked.filePath] };
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  });
  /**
   * Seal a drive before it leaves set: every file the production copied to
   * it, on every day, checked against the drive (and read back, if asked),
   * then a manifest written to it. One at a time; the drive is held from
   * copies and ejecting until it is done.
   */
  let sealing: AbortController | null = null;
  ipcMain.handle('vcdit:project-seal', async (e, id: unknown, verify: unknown): Promise<SealResult> => {
    if (sealing) return { ok: false, reason: 'A drive is already being sealed. Wait for it, or stop it.' };
    const held = hooks.hold(String(id), 'being sealed');
    if (!held.ok) return held;
    const controller = new AbortController();
    sealing = controller;
    let last = 0;
    const progress = (now: SealProgress) => {
      if (Date.now() - last < 200 && now.files < now.totalFiles) return;
      last = Date.now();
      if (!e.sender.isDestroyed()) e.sender.send('vcdit:seal-progress', { id: String(id), ...now });
    };
    try {
      const db = library.current;
      const production = db.production();
      const outcome = await sealDrive({
        root: held.root,
        name: held.name,
        production: segment(production.name || production.code),
        expected: db.sealExpectations(held.root, held.name),
        verify: verify === true,
        tool: { name: 'VC DIT', version: app.getVersion() },
        onProgress: progress,
        signal: controller.signal,
      });
      if (!outcome.ok) return { ok: false, reason: outcome.problems[0] ?? `${held.name} was not sealed.`, outcome };
      db.recordSeal({ root: outcome.root, name: outcome.name, sealedAt: outcome.checkedAt, files: outcome.files, bytes: outcome.bytes, verified: outcome.verified, manifest: outcome.manifest });
      broadcast();
      return { ok: true, outcome };
    } catch (cause) {
      return { ok: false, reason: controller.signal.aborted ? `Stopped. ${held.name} was not sealed.` : cause instanceof Error ? cause.message : String(cause) };
    } finally {
      held.release();
      sealing = null;
    }
  });
  ipcMain.handle('vcdit:project-seal-stop', () => sealing?.abort());
  // The upload key for the open production. The screens never see the key itself.
  ipcMain.handle('vcdit:film-studio-link', () => filmStudioLink(library.current.file));
  ipcMain.handle('vcdit:film-studio-link-set', (_e, key: unknown) => setFilmStudioKey(library.current.file, key));
  ipcMain.handle('vcdit:film-studio-link-clear', () => clearFilmStudioKey(library.current.file));
  // Read the scene folders back on every destination now, or put back what the check found wrong.
  ipcMain.handle('vcdit:project-organize-check', () => answer(() => organizing.check()));
  ipcMain.handle('vcdit:project-organize-repair', () => answer(() => organizing.repair()));
  ipcMain.handle('vcdit:project-organize-show', (_e, path: unknown) => {
    // Only the scene folders VC DIT made.
    if (organizing.view().folders.some((folder) => folder.path === path)) void shell.openPath(String(path));
  });
  ipcMain.handle('vcdit:project-delivery-show', (_e, path: unknown) => {
    // Only manifests VC DIT wrote.
    const db = library.current;
    if (db.deliveries(db.currentDay().number).some((record) => record.mhl === path)) shell.showItemInFolder(String(path));
  });

  return {
    library,
    vfx: mirrors,
    sync: syncing,
    dailies: rendering,
    delivery: delivering,
    organize: organizing,
    changed: broadcast,
    cardIn: (day) => {
      library.current.rematch(day);
      broadcast();
      mirrorQuick();
      syncQuick();
    },
  };
};
