import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  DESTINATION_ROLES,
  SOURCE_ROLES,
  formatBytes,
  type FolderDestination,
  type IngestRequest,
  type IngestResult,
  type JobSnapshot,
  type LegSnapshot,
  type MediaState,
  type MediaVolume,
  type VolumeRole,
} from '../../shared/media';
import type { TransferRecord } from '../db/production-db';
import type { ReportContext } from './reports';
import { cardFolder, destinationProblem, headroom, reportsFolder } from './rules';
import { listSource, type FileOutcome, type LegPlan, type LegProgress, type SourceFile } from './transfer';
import type { WorkerMessage, WorkerPlan } from './transfer-worker';
import { capacityOf, classifyVolume, describeMount, listMounts, type Capacity, type Mount } from './volumes';

/**
 * The media engine's state in the main process: the volumes plugged in and
 * the roles they were given, the folders picked as destinations, and the
 * transfer queue. One transfer runs at a time (the destinations' disks are
 * the limit, and one card at full speed beats two at half), each in its own
 * worker thread. Electron-free apart from what it is handed, so the rules
 * that guard the disks run in tests too.
 */

export interface MediaServiceDeps {
  dataDir: string;
  /** Path of the bundled transfer worker. */
  workerPath: string;
  tool: { name: string; version: string };
  canStartTransfers: () => boolean;
  onChange: (state: MediaState) => void;
  platform?: NodeJS.Platform;
  pollEveryMs?: number;
  /** Keep a transfer in the production's database: when it is queued, and again when it ends. */
  onRecord?: (record: TransferRecord) => void;
  /** Tests: where volumes are found, and how a transfer is run, instead of the system's mounts and a worker thread. */
  mounts?: () => Promise<Mount[]>;
  startWorker?: (plan: WorkerPlan) => TransferRunner;
}

/** The part of a worker thread the service uses. */
export interface TransferRunner {
  on(event: 'message', listener: (message: WorkerMessage) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  postMessage(message: 'stop'): void;
}

interface Settings {
  /** Remembered roles, by volume name and size, so a card keeps its role across mounts. */
  roles: Record<string, VolumeRole>;
  folders: { id: string; name: string; path: string }[];
}

interface Leg {
  plan: LegPlan;
  reportsDir: string;
  /** While a run for this leg is in progress. */
  live: LegProgress | null;
  outcomes: Map<string, FileOutcome>;
  error: string | null;
}

interface Job {
  id: string;
  day: number;
  sound: boolean;
  label: string;
  sourceId: string;
  sourceRoot: string;
  card: string;
  checksum: IngestRequest['checksum'];
  files: SourceFile[];
  /** The card's checksum of each file, once read. */
  hashes: Map<string, { hash: string | null; hashedAt: string | null }>;
  totalBytes: number;
  legs: Leg[];
  bytesPerSecond: number;
  etaSeconds: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Work {
  job: Job;
  legIds: string[];
  /** Only these files (a retry); all when absent. */
  only: Set<string> | null;
}

interface VolumeEntry {
  volume: MediaVolume;
  device: number;
}

const roleKey = (name: string, totalBytes: number) => `${name}|${Math.round(totalBytes / 1e9)}`;

export class MediaService {
  private readonly platform: NodeJS.Platform;
  private settings: Settings = { roles: {}, folders: [] };
  private readonly volumes = new Map<string, VolumeEntry>();
  private readonly describing = new Set<string>();
  private folderCapacity = new Map<string, Capacity | null>();
  private readonly jobs: Job[] = [];
  private readonly queue: Work[] = [];
  private current: { work: Work; worker: TransferRunner } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSent = '';

  constructor(private readonly deps: MediaServiceDeps) {
    this.platform = deps.platform ?? process.platform;
  }

  // ------------------------------------------------ lifecycle

  async start(): Promise<void> {
    try {
      this.settings = { roles: {}, folders: [], ...(JSON.parse(await readFile(this.settingsFile(), 'utf8')) as Partial<Settings>) };
    } catch {
      // First run.
    }
    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.deps.pollEveryMs ?? 2000);
    this.timer.unref?.();
  }

  /** Stop looking for volumes and stop transferring: the running copy cleans up after itself, the queue is dropped. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.queue.length = 0;
    this.current?.worker.postMessage('stop');
  }

  /** Resolves once nothing is running, or after `timeoutMs`. */
  async idle(timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.busy() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /** A transfer is copying or checking: quitting now would leave a card not safe to format. */
  busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  state(): MediaState {
    return {
      volumes: [...this.volumes.values()].map((entry) => entry.volume).sort((a, b) => a.name.localeCompare(b.name)),
      folders: this.folders(),
      jobs: this.jobs.map((job) => this.snapshot(job)),
    };
  }

  private settingsFile() {
    return join(this.deps.dataDir, 'media.json');
  }

  private async saveSettings() {
    await mkdir(this.deps.dataDir, { recursive: true });
    await writeFile(this.settingsFile(), JSON.stringify(this.settings, null, 2), 'utf8');
  }

  private emit(force = false) {
    const state = this.state();
    const text = JSON.stringify(state);
    if (!force && text === this.lastSent) return;
    this.lastSent = text;
    this.deps.onChange(state);
  }

  // ------------------------------------------------ volumes

  async poll(): Promise<void> {
    const mounts = await (this.deps.mounts ? this.deps.mounts() : listMounts(this.platform));
    const seen = new Set<string>();
    for (const mount of mounts) {
      seen.add(mount.path);
      const capacity = await capacityOf(mount.path);
      if (!capacity) continue;
      const known = this.volumes.get(mount.path);
      if (known && known.device === capacity.device) {
        known.volume = { ...known.volume, totalBytes: capacity.totalBytes, freeBytes: capacity.freeBytes };
        continue;
      }
      if (this.describing.has(mount.path)) continue;
      // New, or a different disk at the same path: describe it once, without holding up the poll.
      this.describing.add(mount.path);
      if (known) this.volumes.delete(mount.path);
      void (async () => {
        try {
          const [described, classified] = await Promise.all([describeMount(mount, this.platform), classifyVolume(mount.path)]);
          const remembered = this.settings.roles[roleKey(described.name, capacity.totalBytes)];
          this.volumes.set(mount.path, {
            device: capacity.device,
            volume: {
              id: mount.path,
              name: described.name,
              mountPath: mount.path,
              kind: described.kind,
              filesystem: described.filesystem,
              totalBytes: capacity.totalBytes,
              freeBytes: capacity.freeBytes,
              detected: classified.detected,
              suggestedRole: classified.role,
              role: remembered ?? classified.role,
              ingested: this.jobs.some((job) => job.sourceId === mount.path && !job.finishedAt),
            },
          });
        } finally {
          this.describing.delete(mount.path);
          this.emit();
        }
      })();
    }
    for (const path of [...this.volumes.keys()]) if (!seen.has(path)) this.volumes.delete(path);
    for (const folder of this.settings.folders) this.folderCapacity.set(folder.id, await capacityOf(folder.path));
    this.emit();
  }

  private folders(): FolderDestination[] {
    return this.settings.folders.map((folder) => {
      const capacity = this.folderCapacity.get(folder.id) ?? null;
      return { ...folder, totalBytes: capacity?.totalBytes ?? 0, freeBytes: capacity?.freeBytes ?? 0, online: capacity !== null };
    });
  }

  /** Volumes a queued or running transfer reads from or writes to. */
  private inUse(volumeId: string): boolean {
    const active = [...(this.current ? [this.current.work] : []), ...this.queue];
    return active.some(({ job }) => job.sourceId === volumeId || job.legs.some((leg) => leg.plan.root === volumeId));
  }

  async setRole(volumeId: string, role: VolumeRole): Promise<{ ok: boolean; reason?: string }> {
    const entry = this.volumes.get(volumeId);
    if (!entry) return { ok: false, reason: 'That volume is no longer mounted.' };
    if (this.inUse(volumeId)) return { ok: false, reason: 'A transfer is using this volume. Change its role when the transfer has finished.' };
    entry.volume = { ...entry.volume, role };
    this.settings.roles[roleKey(entry.volume.name, entry.volume.totalBytes)] = role;
    await this.saveSettings();
    this.emit();
    return { ok: true };
  }

  async addFolder(path: string): Promise<{ ok: boolean; reason?: string }> {
    const cards = [...this.volumes.values()].filter((entry) => SOURCE_ROLES.includes(entry.volume.role)).map((entry) => entry.volume.mountPath);
    const problem = destinationProblem(path, cards, this.platform);
    if (problem) return { ok: false, reason: problem };
    if (this.settings.folders.some((folder) => folder.path === path)) return { ok: true };
    const capacity = await capacityOf(path);
    if (!capacity) return { ok: false, reason: 'That folder cannot be reached.' };
    const id = `folder:${path}`;
    this.settings.folders.push({ id, name: basename(path) || path, path });
    this.folderCapacity.set(id, capacity);
    await this.saveSettings();
    this.emit();
    return { ok: true };
  }

  async removeFolder(id: string): Promise<void> {
    if (this.inUse(this.settings.folders.find((folder) => folder.id === id)?.path ?? '')) return;
    this.settings.folders = this.settings.folders.filter((folder) => folder.id !== id);
    await this.saveSettings();
    this.emit();
  }

  // ------------------------------------------------ ingest

  async ingest(request: IngestRequest): Promise<IngestResult> {
    if (!this.deps.canStartTransfers()) return { ok: false, reason: 'Activate VC DIT to start new transfers.' };
    if (request.sources.length === 0) return { ok: false, reason: 'Pick at least one camera or sound card.' };
    if (request.destinations.length === 0) return { ok: false, reason: 'Pick at least one destination.' };

    const cards: MediaVolume[] = [];
    for (const id of request.sources) {
      const volume = this.volumes.get(id)?.volume;
      if (!volume) return { ok: false, reason: 'A card you picked is no longer mounted.' };
      if (!SOURCE_ROLES.includes(volume.role)) return { ok: false, reason: `${volume.name} is not marked as a camera or sound card.` };
      cards.push(volume);
    }
    // Every card mounted now, picked or not, is off limits as a destination.
    const allCards = [...this.volumes.values()].filter((entry) => SOURCE_ROLES.includes(entry.volume.role)).map((entry) => entry.volume.mountPath);

    const destinations: { id: string; name: string; root: string; freeBytes: number }[] = [];
    for (const id of request.destinations) {
      const volume = this.volumes.get(id)?.volume;
      const folder = this.settings.folders.find((candidate) => candidate.id === id);
      if (volume) {
        if (!DESTINATION_ROLES.includes(volume.role)) return { ok: false, reason: `${volume.name} is not marked as a destination, shuttle or archive.` };
        destinations.push({ id, name: volume.name, root: volume.mountPath, freeBytes: volume.freeBytes });
      } else if (folder) {
        const capacity = await capacityOf(folder.path);
        if (!capacity) return { ok: false, reason: `${folder.name} cannot be reached.` };
        destinations.push({ id, name: folder.name, root: folder.path, freeBytes: capacity.freeBytes });
      } else return { ok: false, reason: 'A destination you picked is no longer available.' };
    }
    for (const destination of destinations) {
      const problem = destinationProblem(destination.root, allCards, this.platform);
      if (problem) return { ok: false, reason: `${destination.name}: ${problem}` };
      if (destinations.some((other) => other !== destination && other.root === destination.root)) {
        return { ok: false, reason: `${destination.name} is picked twice.` };
      }
    }

    // List every card before queuing anything, so a size problem refuses the whole request.
    const listed: { card: MediaVolume; files: SourceFile[]; bytes: number }[] = [];
    for (const card of cards) {
      let files: SourceFile[];
      try {
        files = (await listSource(card.mountPath)).files;
      } catch {
        return { ok: false, reason: `${card.name} could not be read.` };
      }
      if (files.length === 0) return { ok: false, reason: `${card.name} has no files to copy.` };
      listed.push({ card, files, bytes: files.reduce((sum, file) => sum + file.size, 0) });
    }
    const wanted = listed.reduce((sum, item) => sum + item.bytes, 0);
    for (const destination of destinations) {
      const pending = this.jobs
        .filter((job) => !job.finishedAt && job.legs.some((leg) => leg.plan.root === destination.root))
        .reduce((sum, job) => sum + job.totalBytes, 0);
      const needed = wanted + pending + headroom(wanted);
      if (needed > destination.freeBytes) {
        return { ok: false, reason: `${destination.name} has ${formatBytes(destination.freeBytes)} free; this needs about ${formatBytes(needed)}.` };
      }
    }

    const ids: string[] = [];
    for (const { card, files, bytes } of listed) {
      const sound = card.role === 'Sound';
      let id = card.name;
      for (let n = 2; this.jobs.some((job) => job.id === id); n += 1) id = `${card.name} (${n})`;
      const job: Job = {
        id,
        day: request.day.number,
        sound,
        label: sound && !card.detected.startsWith('Sound') ? `Sound · ${card.detected}` : card.detected,
        sourceId: card.id,
        sourceRoot: card.mountPath,
        card: card.name,
        checksum: request.checksum,
        files,
        hashes: new Map(),
        totalBytes: bytes,
        legs: destinations.map((destination) => ({
          plan: { id: destination.id, name: destination.name, root: destination.root, targetDir: cardFolder(destination.root, request, sound, card.name) },
          reportsDir: reportsFolder(destination.root, request),
          live: null,
          outcomes: new Map(),
          error: null,
        })),
        bytesPerSecond: 0,
        etaSeconds: null,
        startedAt: null,
        finishedAt: null,
      };
      this.jobs.push(job);
      this.record(job);
      this.queue.push({ job, legIds: job.legs.map((leg) => leg.plan.id), only: null });
      const entry = this.volumes.get(card.id);
      if (entry) entry.volume = { ...entry.volume, ingested: true };
      ids.push(id);
    }
    this.emit(true);
    this.next();
    return { ok: true, jobs: ids };
  }

  /** Copy again, to one destination, the files that did not verify there. */
  retry(jobId: string, legId: string): IngestResult {
    if (!this.deps.canStartTransfers()) return { ok: false, reason: 'Activate VC DIT to start new transfers.' };
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    const leg = job?.legs.find((candidate) => candidate.plan.id === legId || candidate.plan.name === legId);
    if (!job || !leg) return { ok: false, reason: 'That transfer is no longer listed.' };
    if (leg.live || this.queue.some((work) => work.job === job && work.legIds.includes(leg.plan.id))) return { ok: true, jobs: [job.id] };
    const only = new Set(job.files.filter((file) => { const outcome = leg.outcomes.get(file.path); return !outcome || outcome.state === 'failed'; }).map((file) => file.path));
    if (only.size === 0) return { ok: true, jobs: [job.id] };
    leg.error = null;
    for (const path of only) leg.outcomes.delete(path);
    job.finishedAt = null;
    this.queue.push({ job, legIds: [leg.plan.id], only });
    this.emit(true);
    this.next();
    return { ok: true, jobs: [job.id] };
  }

  private next(): void {
    if (this.current) return;
    const work = this.queue.shift();
    if (!work) return;
    const { job } = work;
    const legs = job.legs.filter((leg) => work.legIds.includes(leg.plan.id));
    const files = work.only ? job.files.filter((file) => work.only!.has(file.path)) : job.files;
    const contexts: Record<string, ReportContext> = Object.fromEntries(
      legs.map((leg) => [leg.plan.id, { card: job.card, tool: this.deps.tool, reportsDir: leg.reportsDir }]),
    );
    const plan: WorkerPlan = {
      sourceRoot: job.sourceRoot,
      files,
      legs: legs.map((leg) => leg.plan),
      allLegs: job.legs.map((leg) => leg.plan),
      method: job.checksum,
      contexts,
    };
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    for (const leg of legs) leg.live = { phase: 'copying', totalBytes: bytes, copiedBytes: 0, verifiedBytes: 0, problemFiles: 0, error: null };
    job.startedAt ??= new Date().toISOString();

    const worker: TransferRunner = this.deps.startWorker ? this.deps.startWorker(plan) : new Worker(this.deps.workerPath, { workerData: plan });
    this.current = { work, worker };
    let settled = false;
    let finished = false;
    const end = (failure: string | null) => {
      if (settled) return;
      settled = true;
      for (const leg of legs) {
        if (failure) {
          leg.error = failure;
          for (const file of files) if (!leg.outcomes.has(file.path)) leg.outcomes.set(file.path, { state: 'failed', error: failure });
        }
        leg.live = null;
      }
      job.bytesPerSecond = 0;
      job.etaSeconds = null;
      if (!this.queue.some((queued) => queued.job === job)) job.finishedAt = new Date().toISOString();
      this.current = null;
      this.record(job);
      this.emit(true);
      this.next();
    };

    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'progress') {
        for (const leg of legs) {
          const live = message.progress.legs[leg.plan.id];
          if (live) leg.live = live;
        }
        job.bytesPerSecond = legs.some((leg) => leg.live?.phase === 'copying') ? message.progress.bytesPerSecond : 0;
        const left = message.progress.totalBytes - message.progress.sourceBytesRead;
        job.etaSeconds = job.bytesPerSecond > 0 ? Math.round(left / job.bytesPerSecond) : null;
        this.emit();
      } else if (message.type === 'done') {
        finished = true;
        for (const file of message.result.files) job.hashes.set(file.path, { hash: file.sourceHash, hashedAt: file.hashedAt });
        for (const leg of legs) {
          for (const file of message.result.files) leg.outcomes.set(file.path, file.legs[leg.plan.id] ?? { state: 'failed', error: 'No result.' });
          leg.error = message.result.legs[leg.plan.id]?.error ?? null;
          const written = message.reports.find((report) => report.legId === leg.plan.id);
          if (!leg.error && written?.error) leg.error = `Copies verified, but the transfer log could not be written: ${written.error}`;
        }
        end(null);
      } else end(`The transfer stopped: ${message.message}`);
    });
    worker.on('error', (error) => end(`The transfer stopped: ${error.message}`));
    worker.on('exit', (code) => end(finished && code === 0 ? null : 'The transfer stopped unexpectedly.'));
  }

  private record(job: Job): void {
    if (!this.deps.onRecord) return;
    try {
      this.deps.onRecord({
        id: job.id,
        day: job.day,
        card: job.card,
        label: job.label,
        sourceRoot: job.sourceRoot,
        sound: job.sound,
        checksum: job.checksum,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        files: job.files.map((file) => ({ ...file, hash: job.hashes.get(file.path)?.hash ?? null, hashedAt: job.hashes.get(file.path)?.hashedAt ?? null })),
        destinations: job.legs.map((leg) => ({
          id: leg.plan.id,
          name: leg.plan.name,
          root: leg.plan.root,
          targetDir: leg.plan.targetDir,
          reportsDir: leg.reportsDir,
          error: leg.error,
          outcomes: Object.fromEntries(leg.outcomes),
        })),
      });
    } catch {
      // The destinations hold the transfer logs; a database hiccup must not stop a copy.
    }
  }

  /**
   * Show a day's transfers as the database kept them (at start, or when
   * another day or production is opened). Not while a transfer is running.
   * One that never finished (the app closed mid-copy) shows as failed.
   */
  load(records: TransferRecord[]): boolean {
    if (this.busy()) return false;
    this.jobs.length = 0;
    for (const record of records) {
      const interrupted = record.finishedAt === null;
      const reason = 'VC DIT closed before this transfer finished. Not safe to format: copy it again.';
      this.jobs.push({
        id: record.id,
        day: record.day,
        sound: record.sound,
        label: record.label,
        sourceId: record.sourceRoot,
        sourceRoot: record.sourceRoot,
        card: record.card,
        checksum: record.checksum,
        files: record.files.map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs })),
        hashes: new Map(record.files.map((file) => [file.path, { hash: file.hash, hashedAt: file.hashedAt }])),
        totalBytes: record.files.reduce((sum, file) => sum + file.size, 0),
        legs: record.destinations.map((destination) => {
          const outcomes = new Map(Object.entries(destination.outcomes));
          if (interrupted) for (const file of record.files) if (!outcomes.has(file.path)) outcomes.set(file.path, { state: 'failed', error: reason });
          return {
            plan: { id: destination.id, name: destination.name, root: destination.root, targetDir: destination.targetDir },
            reportsDir: destination.reportsDir,
            live: null,
            outcomes,
            error: destination.error ?? (interrupted ? reason : null),
          };
        }),
        bytesPerSecond: 0,
        etaSeconds: null,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt ?? record.startedAt ?? new Date(0).toISOString(),
      });
    }
    this.emit(true);
    return true;
  }

  // ------------------------------------------------ what the screens see

  private snapshot(job: Job): JobSnapshot {
    const runningLegs = this.current?.work.job === job ? this.current.work.legIds : [];
    return {
      id: job.id,
      label: job.label,
      sourceId: job.sourceId,
      totalBytes: job.totalBytes,
      fileCount: job.files.length,
      queued: !job.legs.some((leg) => leg.live) && job.legs.every((leg) => leg.outcomes.size === 0),
      running: runningLegs.length > 0,
      checksum: job.checksum,
      legs: job.legs.map((leg) => this.legSnapshot(job, leg)),
      bytesPerSecond: job.bytesPerSecond,
      etaSeconds: job.etaSeconds,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  private legSnapshot(job: Job, leg: Leg): LegSnapshot {
    const base = { id: leg.plan.id, name: leg.plan.name, targetDir: leg.plan.targetDir };
    const pct = (part: number, whole: number) => (whole > 0 ? Math.min(100, (part / whole) * 100) : 100);
    if (leg.live) {
      return {
        ...base,
        copyPct: pct(leg.live.copiedBytes, leg.live.totalBytes),
        verifyPct: leg.live.phase === 'copying' ? 0 : pct(leg.live.verifiedBytes, leg.live.totalBytes),
        failed: leg.live.error !== null,
        error: leg.live.error,
        problemFiles: leg.live.problemFiles,
      };
    }
    const failures = [...leg.outcomes.values()].filter((outcome) => outcome.state === 'failed');
    const decided = leg.outcomes.size > 0;
    const waiting = !decided || job.files.some((file) => !leg.outcomes.has(file.path));
    if (waiting && !leg.error) return { ...base, copyPct: 0, verifyPct: 0, failed: false, error: null, problemFiles: 0 };
    const first = failures[0]?.error;
    return {
      ...base,
      copyPct: 100,
      verifyPct: 100,
      failed: failures.length > 0 || leg.error !== null,
      error:
        leg.error ??
        (failures.length ? `${failures.length} file${failures.length === 1 ? '' : 's'} did not verify${first ? `: ${first}` : ''}` : null),
      problemFiles: failures.length,
    };
  }
}
