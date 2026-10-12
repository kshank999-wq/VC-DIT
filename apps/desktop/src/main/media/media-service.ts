import { statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  DESTINATION_ROLES,
  SOURCE_ROLES,
  formatBytes,
  type FolderDestination,
  type IngestRequest,
  type ClearCheck,
  type ClearResult,
  type IngestResult,
  type JobSnapshot,
  type LegSnapshot,
  type MediaState,
  type MediaVolume,
  type VolumeRole,
  type Workflow,
  type WorkflowCamera,
} from '../../shared/media';
import { BRAND_NAME, brandOf } from '../../shared/brands';
import type { TransferRecord } from '../db/production-db';
import type { ReportContext } from './reports';
import { cardFolder, destinationProblem, headroom, isRemote, reportsFolder } from './rules';
import type { FormatRule } from '../../shared/project';
import { checkClear, clearCardFiles } from './clear';
import { isTransient, listSource, STOPPED, type FileOutcome, type LegPlan, type LegProgress, type SourceFile } from './transfer';
import type { WorkerCommand, WorkerMessage, WorkerPlan } from './transfer-worker';
import { capacityOf, classifyVolume, describeMount, ejectVolume, listMounts, type Capacity, type Mount } from './volumes';

/**
 * The media engine's state in the main process: the volumes plugged in and
 * the roles they were given, the folders picked as destinations, and the
 * transfer queue. One card copies at a time (the destinations' disks are
 * the limit, and one card at full speed beats two at half), each in its own
 * worker thread.
 *
 * Relays (spec §4.3.1): a slow destination (a cloud filespace, a network
 * share) is not fed from the card. The card copies to the local backups
 * and is verified there; then the relay reads the first verified backup
 * and uploads from it, checking every file against the checksum the card
 * gave, so the card can come out while the upload carries on. Relays have
 * their own queue, one at a time, alongside the card copies. A relay that
 * loses its backup or its destination waits and tries again; one that is
 * paused, or cut short by quitting, carries on later from the last verified
 * file (a file with no outcome on a relay leg is simply still to upload).
 *
 * Electron-free apart from what it is handed, so the rules that guard the
 * disks run in tests too.
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
  /** The production and day open now, for a workflow that starts a card by itself; null when none is. */
  context?: () => { production: { name: string; code: string }; day: { number: number; date: string } } | null;
  /** A card that followed a workflow has verified: do what comes after (render the dailies). Says what happened. */
  afterCard?: (card: { day: number; card: string; workflow: Workflow }) => Promise<string | null>;
  /** Tests: where volumes are found, and how a transfer is run, instead of the system's mounts and a worker thread. */
  mounts?: () => Promise<Mount[]>;
  startWorker?: (plan: WorkerPlan) => TransferRunner;
  /** Tests: how a volume is ejected (the reason it failed, or null), instead of the system's command. */
  eject?: (mountPath: string) => Promise<string | null>;
}

/** The part of a worker thread the service uses. */
export interface TransferRunner {
  on(event: 'message', listener: (message: WorkerMessage) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  postMessage(message: WorkerCommand): void;
}

interface Settings {
  /** Remembered roles, by volume name and size, so a card keeps its role across mounts. */
  roles: Record<string, VolumeRole>;
  folders: { id: string; name: string; path: string }[];
  /** The operator's choice of relay or straight from the card, by volume (name and size) or folder id. */
  relay: Record<string, boolean>;
  relaysPaused: boolean;
  /** Most bytes a second all uploads may write, or null for no limit. */
  relayLimit: number | null;
  /** Most bytes a second a copy from the backup may write to one drive or folder, by volume (name and size) or folder id. */
  limits?: Record<string, number>;
  workflows?: Workflow[];
}

interface Leg {
  plan: LegPlan;
  reportsDir: string;
  /** While a run for this leg is in progress. */
  live: LegProgress | null;
  outcomes: Map<string, FileOutcome>;
  error: string | null;
  /** Fed from a backup (the leg id in relayFrom, once picked) rather than the card. */
  relay: boolean;
  relayFrom: string | null;
  /** A drive on the cart (not a network share or cloud folder): from the backup it is a cascade copy, not an upload. */
  local: boolean;
  /** Why a relay is not moving; when it may try again after its destination went away. */
  waiting: string | null;
  retryAt: number;
  /** A relay's own speed, time left, file, and the bytes already uploaded before this run. */
  bytesPerSecond: number;
  etaSeconds: number | null;
  currentFile: string | null;
  baseBytes: number;
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
  currentFile: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  clearedAt: string | null;
  /** The workflow it follows (id), and what came after the copy. */
  workflow: string | null;
  followUp: string | null;
}

interface Work {
  job: Job;
  legIds: string[];
  /** Only these files (a retry); all when absent. */
  only: Set<string> | null;
  /** A relay: the backup leg it reads from. */
  from?: string;
  /** A relay: to drives on the cart (a cascade) or to the network (an upload). Each lane runs one at a time, side by side. */
  lane?: Lane;
  /** Why a running relay was stopped: paused (its files are still to upload) or cancelled (they fail, and can be retried). */
  stopping?: 'pause' | 'cancel';
}

type Lane = 'local' | 'remote';
const LANES: Lane[] = ['local', 'remote'];

interface VolumeEntry {
  volume: MediaVolume;
  device: number;
}

const roleKey = (name: string, totalBytes: number) => `${name}|${Math.round(totalBytes / 1e9)}`;

const VERIFIED = new Set(['verified', 'already-there']);
const UPLOAD_STOPPED = 'Upload stopped. Retry to carry on from the backup.';
const RELAY_RETRY_MS = 60_000;
const backupLost = (name: string) => `${name} was disconnected during the upload.`;

const freshLeg = (relay: boolean, local: boolean) => ({
  live: null,
  outcomes: new Map<string, FileOutcome>(),
  error: null,
  relay,
  relayFrom: null,
  local,
  waiting: null,
  retryAt: 0,
  bytesPerSecond: 0,
  etaSeconds: null,
  currentFile: null,
  baseBytes: 0,
});

/** A folder that can be read now, checked without waiting on a slow disk for long. */
const reachable = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export class MediaService {
  /** Drives kept back from copies and ejecting (being sealed), by root: why. */
  private readonly holds = new Map<string, string>();
  /** Cards a workflow would start by itself: why it has not yet. */
  private readonly autoNotes = new Map<string, string>();
  /** Cards a workflow has already tried to start, while they stay mounted. */
  private readonly autoTried = new Set<string>();
  private autoStarting = false;
  private readonly platform: NodeJS.Platform;
  private settings: Settings = { roles: {}, folders: [], relay: {}, relaysPaused: false, relayLimit: null };
  private readonly volumes = new Map<string, VolumeEntry>();
  private readonly describing = new Set<string>();
  private folderCapacity = new Map<string, Capacity | null>();
  private readonly jobs: Job[] = [];
  private readonly queue: Work[] = [];
  private current: { work: Work; worker: TransferRunner } | null = null;
  private readonly relayQueue: Work[] = [];
  /** The from-backup copy running in each lane. */
  private readonly relayRunning = new Map<Lane, { work: Work; worker: TransferRunner }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSent = '';

  constructor(private readonly deps: MediaServiceDeps) {
    this.platform = deps.platform ?? process.platform;
  }

  // ------------------------------------------------ lifecycle

  async start(): Promise<void> {
    try {
      this.settings = { ...this.settings, ...(JSON.parse(await readFile(this.settingsFile(), 'utf8')) as Partial<Settings>) };
    } catch {
      // First run.
    }
    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.deps.pollEveryMs ?? 2000);
    this.timer.unref?.();
  }

  /**
   * Stop looking for volumes and stop transferring: the running copy cleans
   * up after itself, the queue is dropped. A running upload is paused, not
   * failed: it carries on from the backup the next time this day is open.
   */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.queue.length = 0;
    this.relayQueue.length = 0;
    this.current?.worker.postMessage('stop');
    for (const running of this.relayRunning.values()) {
      running.work.stopping = 'pause';
      running.worker.postMessage('stop');
    }
  }

  /**
   * Stop one card's transfer. Running: the copy stops and cleans up its
   * unverified files, which are recorded as stopped. Waiting: it leaves the
   * queue, and nothing of it is copied. Either way it can be retried. With
   * a relay leg named, only that upload stops.
   */
  stopJob(jobId: string, legId?: string): { ok: boolean; reason?: string } {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job) return { ok: false, reason: 'That transfer is no longer in the list.' };
    const only = legId ? job.legs.find((leg) => leg.plan.id === legId && leg.relay) : undefined;
    if (legId && !only) return { ok: false, reason: 'That upload is no longer in the list.' };
    const relayLegs = only ? [only] : job.legs.filter((leg) => leg.relay);
    this.cancelRelays(job, relayLegs);
    if (only) return { ok: true };

    const waiting = this.queue.filter((work) => work.job === job);
    for (const work of waiting) this.queue.splice(this.queue.indexOf(work), 1);
    if (waiting.length && this.current?.work.job !== job) {
      for (const leg of job.legs) {
        if (leg.relay) continue;
        if (leg.outcomes.size === 0) leg.error = 'Stopped before it started.';
        for (const file of job.files) if (!leg.outcomes.has(file.path)) leg.outcomes.set(file.path, { state: 'failed', error: 'Stopped before it started.' });
      }
      job.finishedAt = new Date().toISOString();
      this.record(job);
      this.emit(true);
    }
    if (this.current?.work.job === job) this.current.worker.postMessage('stop');
    return { ok: true };
  }

  /** Uploads stop for good (until retried): what was not uploaded is recorded as stopped. */
  private cancelRelays(job: Job, legs: Leg[]): void {
    if (legs.length === 0) return;
    const ids = new Set(legs.map((leg) => leg.plan.id));
    for (const work of [...this.relayQueue]) {
      if (work.job !== job) continue;
      work.legIds = work.legIds.filter((id) => !ids.has(id));
      if (work.legIds.length === 0) this.relayQueue.splice(this.relayQueue.indexOf(work), 1);
    }
    const running = [...this.relayRunning.values()].filter((run) => run.work.job === job && run.work.legIds.some((id) => ids.has(id)));
    for (const leg of legs) {
      if (running.some((run) => run.work.legIds.includes(leg.plan.id))) continue;
      const left = job.files.filter((file) => !leg.outcomes.has(file.path));
      for (const file of left) leg.outcomes.set(file.path, { state: 'failed', error: UPLOAD_STOPPED });
      leg.waiting = null;
      if (left.length) leg.error = UPLOAD_STOPPED;
    }
    for (const run of running) {
      run.work.stopping = 'cancel';
      run.worker.postMessage('stop');
    }
    this.record(job);
    this.emit(true);
  }

  /** Limit how fast uploads write (bytes a second), or null for no limit. A running upload changes speed at once. */
  async setRelayLimit(bytesPerSecond: number | null): Promise<void> {
    const limit = bytesPerSecond && Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 ? Math.max(100_000, Math.round(bytesPerSecond)) : null;
    this.settings.relayLimit = limit;
    await this.saveSettings();
    this.retune();
    this.emit(true);
  }

  /**
   * Limit how fast copies from the backup write to one drive or folder (bytes
   * a second), or null for no limit: a slow NAS, a shared network. A copy to
   * it that is running changes speed at once.
   */
  async setDriveLimit(id: string, bytesPerSecond: number | null): Promise<{ ok: boolean; reason?: string }> {
    const key = this.driveKey(id);
    if (!key) return { ok: false, reason: 'That destination is no longer available.' };
    const limits = { ...(this.settings.limits ?? {}) };
    if (bytesPerSecond && Number.isFinite(bytesPerSecond) && bytesPerSecond > 0) limits[key] = Math.max(100_000, Math.round(bytesPerSecond));
    else delete limits[key];
    this.settings.limits = limits;
    await this.saveSettings();
    this.retune();
    this.emit(true);
    return { ok: true };
  }

  /** A destination's own speed limit, or null. */
  limitFor(id: string): number | null {
    const key = this.driveKey(id);
    return (key && this.settings.limits?.[key]) || null;
  }

  /** The key a destination's choices are remembered by: a volume by name and size (it keeps them across mounts), a folder by id. */
  private driveKey(id: string): string | null {
    const volume = this.volumes.get(id)?.volume;
    if (volume) return roleKey(volume.name, volume.totalBytes);
    return this.settings.folders.some((folder) => folder.id === id) ? id : null;
  }

  /** The speed a from-backup copy may go: its drives' own limits, and the upload limit for uploads; the lowest wins. */
  private limitOf(work: Work): number | null {
    const limits = work.job.legs
      .filter((leg) => work.legIds.includes(leg.plan.id))
      .map((leg) => this.limitFor(leg.plan.id))
      .concat(work.lane === 'remote' ? [this.settings.relayLimit] : [])
      .filter((limit): limit is number => limit !== null);
    return limits.length ? Math.min(...limits) : null;
  }

  /** Tell each running from-backup copy its speed now. */
  private retune(): void {
    for (const run of this.relayRunning.values()) run.worker.postMessage({ type: 'limit', bytesPerSecond: this.limitOf(run.work) });
  }

  /** Pause or resume every upload. Paused, a running upload stops; its files are still to upload, from the last verified one. */
  async pauseRelays(paused: boolean): Promise<void> {
    this.settings.relaysPaused = paused;
    await this.saveSettings();
    // Uploads only: a cascade copy to a drive on the cart is not network traffic.
    const upload = this.relayRunning.get('remote');
    if (paused && upload) {
      upload.work.stopping = 'pause';
      upload.worker.postMessage('stop');
    }
    if (!paused) {
      for (const job of this.jobs) for (const leg of job.legs) if (leg.relay && !leg.local) leg.retryAt = 0;
      this.nextRelay();
    }
    this.emit(true);
  }

  /** Resolves once nothing is running, or after `timeoutMs`. */
  async idle(timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.busy() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /** Something is copying or uploading now, or a card is waiting to copy. */
  busy(): boolean {
    return this.cardBusy() || this.relayRunning.size > 0;
  }

  /** A card is copying or checking, or waiting to: quitting now would leave it not safe to format. */
  cardBusy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  /** Uploads not yet finished: running, waiting their turn, or paused. */
  relaysPending(): number {
    return this.jobs.reduce((sum, job) => sum + job.legs.filter((leg) => leg.relay && !leg.error && job.files.some((file) => !leg.outcomes.has(file.path))).length, 0);
  }

  state(): MediaState {
    return {
      volumes: [...this.volumes.values()]
        .map((entry) => ({
          ...entry.volume,
          relay: this.relayFor(entry.volume.id),
          local: this.isLocal(entry.volume.id),
          limit: this.limitFor(entry.volume.id),
          workflow: this.workflowFor(entry.volume)?.id ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      folders: this.folders(),
      jobs: this.jobs.map((job) => this.snapshot(job)),
      relaysPaused: this.settings.relaysPaused,
      relayLimit: this.settings.relayLimit,
      workflows: this.workflows().map((workflow) => {
        const { ids, missing } = this.resolveWorkflow(workflow);
        return { ...workflow, here: ids, missing };
      }),
      autoStart: Object.fromEntries(this.autoNotes),
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
              device: described.device,
              relay: false,
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
    for (const path of [...this.volumes.keys()]) {
      if (seen.has(path)) continue;
      this.volumes.delete(path);
      this.autoTried.delete(path);
      this.autoNotes.delete(path);
    }
    for (const folder of this.settings.folders) this.folderCapacity.set(folder.id, await capacityOf(folder.path));
    // A backup plugged back in, or a destination's wait over: carry on uploading.
    this.nextRelay();
    await this.autoStartCards();
    this.emit();
  }

  // ------------------------------------------------ saved workflows

  workflows(): Workflow[] {
    return this.settings.workflows ?? [];
  }

  /** The workflow a card follows: its maker's, else the one for any camera; a sound card's, for sound. */
  workflowFor(volume: MediaVolume): Workflow | null {
    if (!SOURCE_ROLES.includes(volume.role)) return null;
    const all = this.workflows();
    if (volume.role === 'Sound') return all.find((workflow) => workflow.camera === 'sound') ?? null;
    const brand = brandOf(volume.detected);
    return (brand && all.find((workflow) => workflow.camera === brand)) || all.find((workflow) => workflow.camera === 'any') || null;
  }

  /** Save a workflow from the destinations picked now (by id); the same id replaces it. */
  async saveWorkflow(input: { id?: string; name: string; camera: WorkflowCamera; destinations: string[]; checksum: IngestRequest['checksum']; autoStart: boolean; dailies: boolean }): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    const name = String(input.name ?? '').trim().slice(0, 60);
    if (!name) return { ok: false, reason: 'Give the workflow a name.' };
    const cameras: WorkflowCamera[] = ['any', 'sound', ...(Object.keys(BRAND_NAME) as WorkflowCamera[])];
    if (!cameras.includes(input.camera)) return { ok: false, reason: 'Say which cards it is for.' };
    if (!['xxHash64', 'MD5', 'SHA-1'].includes(input.checksum)) return { ok: false, reason: 'Pick a checksum.' };
    const destinations: Workflow['destinations'] = [];
    for (const id of input.destinations ?? []) {
      const key = this.driveKey(id);
      const drive = this.destinations().find((candidate) => candidate.id === id);
      if (!key || !drive) return { ok: false, reason: 'A destination you picked is no longer available.' };
      if (!destinations.some((destination) => destination.key === key)) destinations.push({ key, name: drive.name });
    }
    if (destinations.length === 0) return { ok: false, reason: 'Pick at least one destination for it.' };
    const all = this.workflows();
    const id = input.id && all.some((workflow) => workflow.id === input.id) ? input.id : `wf-${Date.now().toString(36)}-${all.length}`;
    // One workflow per kind of card: saving another for the same cards replaces it.
    const kept = all.filter((workflow) => workflow.id !== id && workflow.camera !== input.camera);
    this.settings.workflows = [...kept, { id, name, camera: input.camera, destinations, checksum: input.checksum, autoStart: input.autoStart === true, dailies: input.dailies === true }];
    await this.saveSettings();
    this.autoTried.clear();
    this.emit(true);
    return { ok: true, id };
  }

  async removeWorkflow(id: string): Promise<void> {
    this.settings.workflows = this.workflows().filter((workflow) => workflow.id !== id);
    await this.saveSettings();
    this.emit(true);
  }

  /** A workflow's destinations as they are mounted now (ids), and the ones that are not here (names). */
  resolveWorkflow(workflow: Workflow): { ids: string[]; missing: string[] } {
    const ids: string[] = [];
    const missing: string[] = [];
    const here = this.destinations();
    for (const destination of workflow.destinations) {
      const found = here.find((candidate) => this.driveKey(candidate.id) === destination.key);
      if (found) ids.push(found.id);
      else missing.push(destination.name);
    }
    return { ids, missing };
  }

  /**
   * Start, by itself, each card whose workflow says so, once every drive it
   * names is in. A card copied earlier today and plugged in again is not
   * started again: that is for the DIT to decide.
   */
  private async autoStartCards(): Promise<void> {
    if (this.autoStarting) return;
    this.autoStarting = true;
    try {
      for (const { volume } of [...this.volumes.values()]) {
        const workflow = this.workflowFor(volume);
        if (!workflow?.autoStart || volume.ingested || this.autoTried.has(volume.id)) {
          if (!workflow?.autoStart) this.autoNotes.delete(volume.id);
          continue;
        }
        const note = (why: string) => this.autoNotes.set(volume.id, why);
        if (this.jobs.some((job) => job.card === volume.name && !job.clearedAt)) {
          note('Copied earlier today, so it was not started again. Start it by hand to copy it again.');
          continue;
        }
        const context = this.deps.context?.();
        if (!context) {
          note('Open a production to start it.');
          continue;
        }
        if (!this.deps.canStartTransfers()) {
          note('Activate VC DIT to start it.');
          continue;
        }
        const { ids, missing } = this.resolveWorkflow(workflow);
        if (missing.length) {
          note(`Waiting for ${missing.join(', ')} to start ${workflow.name}.`);
          continue;
        }
        this.autoTried.add(volume.id);
        const result = await this.ingest({ sources: [volume.id], destinations: ids, checksum: workflow.checksum, production: context.production, day: context.day, workflow: workflow.id });
        if (result.ok) this.autoNotes.delete(volume.id);
        else note(`${workflow.name} did not start: ${result.reason}`);
      }
    } finally {
      this.autoStarting = false;
    }
  }

  private folders(): FolderDestination[] {
    return this.settings.folders.map((folder) => {
      const capacity = this.folderCapacity.get(folder.id) ?? null;
      return {
        ...folder,
        totalBytes: capacity?.totalBytes ?? 0,
        freeBytes: capacity?.freeBytes ?? 0,
        online: capacity !== null,
        relay: this.relayFor(folder.id),
        local: this.isLocal(folder.id),
        limit: this.limitFor(folder.id),
      };
    });
  }

  /** Where copies may go now: volumes marked to receive them, and reachable destination folders. */
  destinations(): { id: string; name: string; kind: string; root: string }[] {
    return [
      ...[...this.volumes.values()]
        .filter((entry) => DESTINATION_ROLES.includes(entry.volume.role))
        .map(({ volume }) => ({ id: volume.id, name: volume.name, kind: volume.role, root: volume.mountPath })),
      ...this.folders()
        .filter((folder) => folder.online)
        .map((folder) => ({ id: folder.id, name: folder.name, kind: 'Folder', root: folder.path })),
    ];
  }

  /**
   * Keep a destination to itself for a while (being sealed): nothing is
   * copied to it and it is not ejected until it is let go. Refused while a
   * transfer is using it.
   */
  hold(id: string, why: string): { ok: true; root: string; name: string; release: () => void } | { ok: false; reason: string } {
    const drive = this.destinations().find((candidate) => candidate.id === id);
    if (!drive) return { ok: false, reason: 'That drive is no longer available.' };
    if (this.inUse(id) || this.inUse(drive.root)) return { ok: false, reason: `${drive.name} is being copied to. Try again when the transfer has finished.` };
    const already = this.holds.get(drive.root);
    if (already) return { ok: false, reason: `${drive.name} is already ${already}.` };
    this.holds.set(drive.root, why);
    this.emit(true);
    return {
      ok: true,
      root: drive.root,
      name: drive.name,
      release: () => {
        this.holds.delete(drive.root);
        this.emit(true);
      },
    };
  }

    /** Volumes a queued or running transfer reads from or writes to. */
  private inUse(volumeId: string): boolean {
    const active = [...(this.current ? [this.current.work] : []), ...[...this.relayRunning.values()].map((run) => run.work), ...this.queue, ...this.relayQueue];
    // Only the drives a piece of work touches: a card copy reads the card and writes its local copies; an
    // upload reads one backup and writes its uploads. A shuttle is free to go while the RAID feeds the cloud.
    return active.some((work) => {
      const touched = work.job.legs.filter((leg) => work.legIds.includes(leg.plan.id) || leg.plan.id === work.from);
      return (work.from === undefined && work.job.sourceId === volumeId) || touched.some((leg) => leg.plan.root === volumeId);
    });
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

  /** A drive or folder on the cart, not on the network or in the cloud. */
  isLocal(id: string): boolean {
    const volume = this.volumes.get(id)?.volume;
    if (volume) return !isRemote(volume.kind, volume.filesystem, volume.name, volume.device?.bus);
    const folder = this.settings.folders.find((candidate) => candidate.id === id);
    return folder ? !isRemote(folder.path, folder.name) : true;
  }

  /** Is this destination fed from the backup (true) or straight from the card? The operator's choice, else by what it is. */
  relayFor(id: string): boolean {
    const volume = this.volumes.get(id)?.volume;
    const folder = this.settings.folders.find((candidate) => candidate.id === id);
    const chosen = this.settings.relay[volume ? roleKey(volume.name, volume.totalBytes) : id];
    if (chosen !== undefined) return chosen;
    if (volume) return isRemote(volume.kind, volume.filesystem, volume.name, volume.device?.bus);
    return folder ? isRemote(folder.path, folder.name) : false;
  }

  async setRelay(id: string, relay: boolean): Promise<{ ok: boolean; reason?: string }> {
    const volume = this.volumes.get(id)?.volume;
    if (!volume && !this.settings.folders.some((folder) => folder.id === id)) return { ok: false, reason: 'That destination is no longer available.' };
    this.settings.relay[volume ? roleKey(volume.name, volume.totalBytes) : id] = relay;
    await this.saveSettings();
    this.emit(true);
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

    const destinations: { id: string; name: string; root: string; freeBytes: number; relay: boolean; local: boolean }[] = [];
    for (const id of request.destinations) {
      const volume = this.volumes.get(id)?.volume;
      const folder = this.settings.folders.find((candidate) => candidate.id === id);
      if (volume) {
        if (!DESTINATION_ROLES.includes(volume.role)) return { ok: false, reason: `${volume.name} is not marked as a destination, shuttle or archive.` };
        destinations.push({ id, name: volume.name, root: volume.mountPath, freeBytes: volume.freeBytes, relay: this.relayFor(id), local: this.isLocal(id) });
      } else if (folder) {
        const capacity = await capacityOf(folder.path);
        if (!capacity) return { ok: false, reason: `${folder.name} cannot be reached.` };
        destinations.push({ id, name: folder.name, root: folder.path, freeBytes: capacity.freeBytes, relay: this.relayFor(id), local: this.isLocal(id) });
      } else return { ok: false, reason: 'A destination you picked is no longer available.' };
    }
    for (const destination of destinations) {
      const held = this.holds.get(destination.root);
      if (held) return { ok: false, reason: `${destination.name} is ${held}. Copy to it when that has finished.` };
      const problem = destinationProblem(destination.root, allCards, this.platform);
      if (problem) return { ok: false, reason: `${destination.name}: ${problem}` };
      if (destinations.some((other) => other !== destination && other.root === destination.root)) {
        return { ok: false, reason: `${destination.name} is picked twice.` };
      }
    }

    if (destinations.every((destination) => destination.relay)) {
      return { ok: false, reason: 'Pick at least one destination that copies straight from the card, like the RAID. Uploads are fed from it once the card has verified there.' };
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
          ...freshLeg(destination.relay, destination.local),
        })),
        bytesPerSecond: 0,
        etaSeconds: null,
        currentFile: null,
        startedAt: null,
        finishedAt: null,
        clearedAt: null,
        workflow: request.workflow && this.workflows().some((workflow) => workflow.id === request.workflow) ? request.workflow : null,
        followUp: null,
      };
      this.jobs.push(job);
      this.record(job);
      this.queue.push({ job, legIds: job.legs.filter((leg) => !leg.relay).map((leg) => leg.plan.id), only: null });
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
    if (leg.relay) {
      for (const [path, outcome] of [...leg.outcomes]) if (outcome.state === 'failed') leg.outcomes.delete(path);
      leg.error = null;
      leg.retryAt = 0;
      this.queueRelays(job, [leg]);
      this.emit(true);
      return { ok: true, jobs: [job.id] };
    }
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
    this.current = this.launch(work, (job) => this.cardEnded(job));
  }

  /** A card's copy ended: it is finished if nothing else of it waits, and its uploads can start from a verified backup. */
  private cardEnded(job: Job): void {
    this.current = null;
    if (!this.queue.some((queued) => queued.job === job)) job.finishedAt = new Date().toISOString();
    this.record(job);
    this.queueRelays(job);
    this.followUp(job);
    this.emit(true);
    this.next();
  }

  /** A card that followed a workflow and verified everywhere it was copied from the card: what comes after. */
  private followUp(job: Job): void {
    const workflow = this.workflows().find((candidate) => candidate.id === job.workflow);
    if (!workflow?.dailies || !job.finishedAt || job.followUp || !this.deps.afterCard) return;
    const verified = job.legs.filter((leg) => !leg.relay).every((leg) => job.files.every((file) => VERIFIED.has(leg.outcomes.get(file.path)?.state ?? '')));
    if (!verified) {
      job.followUp = 'Dailies not started: the card did not verify everywhere.';
      return;
    }
    job.followUp = 'Starting dailies…';
    void this.deps
      .afterCard({ day: job.day, card: job.card, workflow })
      .then((said) => (job.followUp = said), (cause: unknown) => (job.followUp = `Dailies not started: ${cause instanceof Error ? cause.message : String(cause)}`))
      .finally(() => this.emit(true));
  }

  /** The backup an upload reads from: the local copy with the most verified files (the first picked, of equals). */
  private backupFor(job: Job): Leg | null {
    const ok = (leg: Leg) => job.files.filter((file) => VERIFIED.has(leg.outcomes.get(file.path)?.state ?? '')).length;
    const local = job.legs.filter((leg) => !leg.relay && !leg.live && ok(leg) > 0);
    return local.sort((a, b) => ok(b) - ok(a))[0] ?? null;
  }

  /**
   * Queue the uploads of a card whose copy has finished: every file not yet
   * uploaded, from the best verified backup. A file that verified on no
   * backup is not uploaded (there is nothing checked to send).
   */
  private queueRelays(job: Job, legs = job.legs.filter((leg) => leg.relay)): void {
    if (legs.length === 0 || this.current?.work.job === job || this.queue.some((work) => work.job === job)) return;
    for (const leg of legs) {
      if (leg.live || leg.error || this.relayQueue.some((work) => work.job === job && work.legIds.includes(leg.plan.id))) continue;
      if ([...this.relayRunning.values()].some((run) => run.work.job === job && run.work.legIds.includes(leg.plan.id))) continue;
      const pending = job.files.filter((file) => !leg.outcomes.has(file.path));
      if (pending.length === 0) continue;
      const backup = this.backupFor(job);
      if (!backup) {
        for (const file of pending) leg.outcomes.set(file.path, { state: 'failed', error: 'Not verified on any backup, so there was nothing checked to upload. Copy the card again.' });
        leg.error = 'The card did not verify on any backup, so nothing was uploaded.';
        continue;
      }
      const only = new Set<string>();
      for (const file of pending) {
        if (VERIFIED.has(backup.outcomes.get(file.path)?.state ?? '') && job.hashes.get(file.path)?.hash) only.add(file.path);
        else leg.outcomes.set(file.path, { state: 'failed', error: `Not verified on ${backup.plan.name}, so it was not uploaded.` });
      }
      leg.relayFrom = backup.plan.id;
      if (only.size === 0) continue;
      const lane: Lane = leg.local ? 'local' : 'remote';
      // Two copies of the same files from the same backup, in the same lane at the same speed, read it once.
      const same = this.relayQueue.find(
        (work) =>
          work.job === job &&
          work.from === backup.plan.id &&
          work.lane === lane &&
          work.legIds.every((id) => this.limitFor(id) === this.limitFor(leg.plan.id)) &&
          work.only!.size === only.size &&
          [...only].every((path) => work.only!.has(path)),
      );
      if (same) same.legIds.push(leg.plan.id);
      else this.relayQueue.push({ job, legIds: [leg.plan.id], only, from: backup.plan.id, lane });
    }
    this.record(job);
    this.nextRelay();
  }

  /** Start the next from-backup copy in each lane that is free: cascades to drives on the cart and uploads run side by side. */
  private nextRelay(): void {
    for (const lane of LANES) this.nextInLane(lane);
  }

  private nextInLane(lane: Lane): void {
    if (this.relayRunning.has(lane)) return;
    for (const work of this.relayQueue) {
      if ((work.lane ?? 'remote') !== lane) continue;
      const legs = work.job.legs.filter((leg) => work.legIds.includes(leg.plan.id));
      const backup = work.job.legs.find((leg) => leg.plan.id === work.from)!;
      const say = (why: string | null) => {
        for (const leg of legs) leg.waiting = why;
      };
      if (lane === 'remote' && this.settings.relaysPaused) {
        say('Paused');
        continue;
      }
      if (legs.every((leg) => leg.retryAt > Date.now())) continue;
      if (!this.deps.canStartTransfers()) {
        say('Activate VC DIT to carry on uploading.');
        continue;
      }
      if (!reachable(backup.plan.targetDir)) {
        say(`Waiting for ${backup.plan.name}: plug it back in to carry on.`);
        continue;
      }
      say(null);
      this.relayQueue.splice(this.relayQueue.indexOf(work), 1);
      this.relayRunning.set(lane, this.launch(work, (job) => this.relayEnded(job, work)));
      return;
    }
  }

  /**
   * An upload ended. A file it could not send because the backup or the
   * destination went away is still to upload, and so is one it stopped on
   * when paused; the destination tries again in a minute. Anything else
   * that failed (a checksum that did not match) stays failed.
   */
  private relayEnded(job: Job, work: Work): void {
    this.relayRunning.delete(work.lane ?? 'remote');
    const backup = job.legs.find((leg) => leg.plan.id === work.from);
    const lost = backup ? backupLost(backup.plan.name) : '';
    for (const leg of job.legs.filter((candidate) => work.legIds.includes(candidate.plan.id))) {
      const transient = isTransient(leg.error);
      for (const [path, outcome] of [...leg.outcomes]) {
        if (outcome.state !== 'failed') continue;
        const again = outcome.error === lost || (transient && outcome.error === leg.error) || (work.stopping === 'pause' && outcome.error === STOPPED);
        if (again) leg.outcomes.delete(path);
        else if (work.stopping === 'cancel' && outcome.error === STOPPED) leg.outcomes.set(path, { state: 'failed', error: UPLOAD_STOPPED });
      }
      if (transient) {
        leg.waiting = `${leg.error} Trying again in a minute.`;
        leg.retryAt = Date.now() + RELAY_RETRY_MS;
        leg.error = null;
      } else if (work.stopping === 'cancel') leg.error = UPLOAD_STOPPED;
      else if (work.stopping === 'pause' || leg.error === lost) leg.error = null;
      leg.bytesPerSecond = 0;
      leg.etaSeconds = null;
      leg.currentFile = null;
    }
    this.record(job);
    if (work.stopping !== 'cancel') this.queueRelays(job, job.legs.filter((leg) => work.legIds.includes(leg.plan.id)));
    this.emit(true);
    this.nextRelay();
  }

  /** Run one piece of work in a worker: a card to its local destinations, or a backup to its uploads. */
  private launch(work: Work, ended: (job: Job) => void): { work: Work; worker: TransferRunner } {
    const { job } = work;
    const relay = work.from !== undefined;
    const backup = relay ? job.legs.find((leg) => leg.plan.id === work.from)! : null;
    const legs = job.legs.filter((leg) => work.legIds.includes(leg.plan.id));
    const chosen = work.only ? job.files.filter((file) => work.only!.has(file.path)) : job.files;
    // An upload checks each file read from the backup against the card's own checksum.
    const files = relay ? chosen.map((file) => ({ ...file, expected: job.hashes.get(file.path)?.hash ?? null })) : chosen;
    const contexts: Record<string, ReportContext> = Object.fromEntries(
      legs.map((leg) => [leg.plan.id, { card: job.card, tool: this.deps.tool, reportsDir: leg.reportsDir }]),
    );
    const plan: WorkerPlan = {
      sourceRoot: backup ? backup.plan.targetDir : job.sourceRoot,
      files,
      legs: legs.map((leg) => leg.plan),
      allLegs: job.legs.map((leg) => leg.plan),
      method: job.checksum,
      sourceLost: backup ? backupLost(backup.plan.name) : undefined,
      // From the backup: at the speed set for the drives (and for uploads), in small reads so the limit is smooth.
      limit: relay ? this.limitOf(work) : null,
      chunkBytes: relay ? 1024 * 1024 : undefined,
      contexts,
    };
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    for (const leg of legs) {
      leg.live = { phase: 'copying', totalBytes: bytes, copiedBytes: 0, verifiedBytes: 0, problemFiles: 0, error: null };
      leg.baseBytes = relay ? job.totalBytes - bytes : 0;
      leg.waiting = null;
    }
    job.startedAt ??= new Date().toISOString();

    const worker: TransferRunner = this.deps.startWorker ? this.deps.startWorker(plan) : new Worker(this.deps.workerPath, { workerData: plan });
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
      if (!relay) {
        job.bytesPerSecond = 0;
        job.etaSeconds = null;
        job.currentFile = null;
      }
      ended(job);
    };

    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'progress') {
        for (const leg of legs) {
          const live = message.progress.legs[leg.plan.id];
          if (live) leg.live = live;
        }
        const moving = legs.some((leg) => leg.live?.phase === 'copying') ? message.progress.bytesPerSecond : 0;
        const left = message.progress.totalBytes - message.progress.sourceBytesRead;
        const eta = moving > 0 ? Math.round(left / moving) : null;
        if (relay) {
          for (const leg of legs) {
            leg.bytesPerSecond = moving;
            leg.etaSeconds = eta;
            leg.currentFile = message.progress.currentFile ?? null;
          }
        } else {
          job.bytesPerSecond = moving;
          job.etaSeconds = eta;
          job.currentFile = message.progress.currentFile ?? null;
        }
        this.emit();
      } else if (message.type === 'done') {
        finished = true;
        if (!relay) for (const file of message.result.files) job.hashes.set(file.path, { hash: file.sourceHash, hashedAt: file.hashedAt });
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
    return { work, worker };
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
        clearedAt: job.clearedAt,
        files: job.files.map((file) => ({ ...file, hash: job.hashes.get(file.path)?.hash ?? null, hashedAt: job.hashes.get(file.path)?.hashedAt ?? null })),
        destinations: job.legs.map((leg) => ({
          id: leg.plan.id,
          name: leg.plan.name,
          root: leg.plan.root,
          targetDir: leg.plan.targetDir,
          reportsDir: leg.reportsDir,
          error: leg.error,
          outcomes: Object.fromEntries(leg.outcomes),
          relay: leg.relay,
          relayFrom: leg.relayFrom,
          local: leg.local,
        })),
      });
    } catch {
      // The destinations hold the transfer logs; a database hiccup must not stop a copy.
    }
  }

  /**
   * Show a day's transfers as the database kept them (at start, or when
   * another day or production is opened). Not while a transfer is running.
   * One that never finished (the app closed mid-copy) shows as failed. An
   * upload that never finished carries on from its backup.
   */
  load(records: TransferRecord[]): boolean {
    if (this.busy()) return false;
    this.jobs.length = 0;
    this.relayQueue.length = 0;
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
          const relay = destination.relay === true;
          if (interrupted && !relay) for (const file of record.files) if (!outcomes.has(file.path)) outcomes.set(file.path, { state: 'failed', error: reason });
          return {
            ...freshLeg(relay, destination.local ?? !isRemote(destination.root, destination.name)),
            plan: { id: destination.id, name: destination.name, root: destination.root, targetDir: destination.targetDir },
            reportsDir: destination.reportsDir,
            outcomes,
            error: destination.error ?? (interrupted && !relay ? reason : null),
            relayFrom: destination.relayFrom ?? null,
          };
        }),
        bytesPerSecond: 0,
        etaSeconds: null,
        currentFile: null,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt ?? record.startedAt ?? new Date(0).toISOString(),
        clearedAt: record.clearedAt ?? null,
        workflow: null,
        followUp: null,
      });
    }
    for (const job of this.jobs) if (job.legs.some((leg) => leg.relay)) this.queueRelays(job);
    this.emit(true);
    return true;
  }

  // ------------------------------------------------ clearing a card for camera

  /** Why this card cannot be checked for clearing at all (not mounted, still copying…), or null. */
  private clearBlocker(job: Job): string | null {
    if (job.clearedAt) return `${job.card} was already cleared.`;
    const volume = this.volumes.get(job.sourceId)?.volume;
    if (!volume || volume.mountPath !== job.sourceRoot) return `${job.card} is not plugged in.`;
    if (volume.name !== job.card) return `The card plugged in at ${job.sourceRoot} is ${volume.name}, not ${job.card}.`;
    if (!SOURCE_ROLES.includes(volume.role)) return `${volume.name} is not marked as a camera or sound card.`;
    const busy = [...(this.current ? [this.current.work] : []), ...this.queue].some((work) => work.job.sourceRoot === job.sourceRoot);
    if (busy) return `${job.card} is still being copied.`;
    if (job.legs.some((leg) => leg.live)) return `${job.card} is still being checked.`;
    return null;
  }

  private clearInput(job: Job, rule: FormatRule) {
    return {
      card: job.card,
      sourceRoot: job.sourceRoot,
      files: job.files,
      legs: job.legs.map((leg) => ({ name: leg.plan.name, targetDir: leg.plan.targetDir, relay: leg.relay, local: leg.local, outcomes: leg.outcomes })),
      rule,
    };
  }

  /** Is everything on this card safely elsewhere, checked now? Nothing is changed. */
  async checkClear(jobId: string, rule: FormatRule): Promise<ClearCheck | { ok: false; problems: string[] }> {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job) return { ok: false, problems: ['That card is no longer in the list.'] };
    const blocker = this.clearBlocker(job);
    if (blocker) return { ok: false, problems: [blocker] };
    return checkClear(this.clearInput(job, rule));
  }

  /**
   * Erase the card's ingested files so it can go back to camera: checked
   * again first, whatever was checked before, and only if all is well.
   * Each copy relied on gets a note of it beside its transfer log.
   */
  async clearCard(jobId: string, rule: FormatRule): Promise<ClearResult> {
    if (!this.deps.canStartTransfers()) return { ok: false, reason: 'Activate VC DIT to clear cards.' };
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job) return { ok: false, reason: 'That card is no longer in the list.' };
    const blocker = this.clearBlocker(job);
    if (blocker) return { ok: false, reason: blocker };
    const check = await checkClear(this.clearInput(job, rule));
    if (!check.ok) return { ok: false, reason: `Not cleared: ${check.problems[0]}`, check };
    const result = await clearCardFiles(job.sourceRoot, job.files);
    if (result.failed.length) {
      return { ok: false, reason: `${result.failed.length} file(s) could not be erased (${result.failed[0]!.error}). The card may be locked or read-only; ${result.removed} were erased.`, check };
    }
    job.clearedAt = new Date().toISOString();
    this.record(job);
    const counted = rule === 'every' ? job.legs : job.legs.filter((leg) => !leg.relay);
    const note = {
      card: job.card,
      clearedAt: job.clearedAt,
      filesErased: result.removed,
      bytes: check.bytes,
      copiesCheckedFirst: check.copies.map((copy) => copy.name),
      rule,
      tool: this.deps.tool,
    };
    const stamp = job.clearedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    for (const leg of counted) {
      await mkdir(leg.reportsDir, { recursive: true })
        .then(() => writeFile(join(leg.reportsDir, `${job.card}_cleared_${stamp}.json`), JSON.stringify(note, null, 2), 'utf8'))
        .catch(() => undefined);
    }
    void this.poll();
    this.emit(true);
    return { ok: true, removed: result.removed, check };
  }

  /**
   * Why a camera or sound card may not come out yet, or null when it may:
   * everything on it now must have verified on at least one drive, copied
   * straight from the card (an upload does not count), with nothing new or
   * changed on it since. A card already cleared, or empty, may go.
   */
  private async notBackedUp(volume: MediaVolume): Promise<string | null> {
    if (DESTINATION_ROLES.includes(volume.role)) return this.notComplete(volume);
    if (!SOURCE_ROLES.includes(volume.role)) return null;
    const jobs = this.jobs.filter((job) => job.sourceRoot === volume.mountPath && job.card === volume.name);
    if (jobs.at(-1)?.clearedAt) return null;
    let onCard: SourceFile[];
    try {
      onCard = (await listSource(volume.mountPath)).files;
    } catch {
      return `${volume.name} cannot be read, so VC DIT cannot tell that it is backed up. Eject it from Finder or Explorer if you are sure.`;
    }
    if (onCard.length === 0) return null;
    const backedUp = jobs.some((job) => {
      const copied = new Map(job.files.map((file) => [file.path, file]));
      if (!onCard.every((file) => copied.get(file.path)?.size === file.size)) return false;
      return job.legs.some((leg) => !leg.relay && onCard.every((file) => VERIFIED.has(leg.outcomes.get(file.path)?.state ?? '')));
    });
    if (backedUp) return null;
    return jobs.length === 0
      ? `${volume.name} has not been backed up. It can be ejected once everything on it has been copied and verified on at least one drive.`
      : `${volume.name} is not fully backed up: not everything on it has verified on any one drive (or something on it is new or changed). Copy it again, then eject.`;
  }

  /**
   * Why a shuttle (or any drive copies go to) may not leave yet, or null
   * when it may: every card copied to it must have verified there. One
   * still to copy, or with a copy that failed, keeps it in.
   */
  private notComplete(volume: MediaVolume): string | null {
    let pending = 0;
    let failed = 0;
    for (const job of this.jobs) {
      for (const leg of job.legs) {
        if (leg.plan.root !== volume.mountPath) continue;
        const outcomes = job.files.map((file) => leg.outcomes.get(file.path));
        if (outcomes.some((outcome) => outcome?.state === 'failed') || leg.error) failed += 1;
        else if (outcomes.some((outcome) => !outcome)) pending += 1;
      }
    }
    const cards = (n: number) => `${n} card${n === 1 ? '' : 's'}`;
    if (failed) return `${volume.name} has ${cards(failed)} whose copy failed there. Retry the copy (Verify) so everything on it is verified, then eject.`;
    if (pending) return `${volume.name} still has ${cards(pending)} to copy or check. Eject it when they have verified.`;
    return null;
  }

  /**
   * Eject a card or drive, as Finder or Explorer would. Not while anything
   * reads from or writes to it. Done only when it has really gone.
   */
  async eject(volumeId: string): Promise<{ ok: boolean; reason?: string }> {
    const entry = this.volumes.get(volumeId);
    if (!entry) return { ok: true };
    const { volume } = entry;
    if (this.inUse(volumeId) || this.inUse(volume.mountPath)) return { ok: false, reason: `${volume.name} is being copied. Eject it when the transfer has finished.` };
    const held = this.holds.get(volume.mountPath);
    if (held) return { ok: false, reason: `${volume.name} is ${held}. Eject it when that has finished.` };
    const unsafe = await this.notBackedUp(volume);
    if (unsafe) return { ok: false, reason: unsafe };
    const failed = await (this.deps.eject ? this.deps.eject(volume.mountPath) : ejectVolume(volume.mountPath, this.platform));
    // Gone from the system's list, or still there: the list says which.
    for (let i = 0; i < 20; i += 1) {
      const mounts = await (this.deps.mounts ? this.deps.mounts() : listMounts(this.platform));
      if (!mounts.some((mount) => mount.path === volume.mountPath)) {
        this.volumes.delete(volumeId);
        this.emit(true);
        return { ok: true };
      }
      if (failed) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, reason: `${volume.name} was not ejected. ${failed ?? 'Another app may be using it.'}` };
  }

  // ------------------------------------------------ what the screens see

  private snapshot(job: Job): JobSnapshot {
    const runningLegs = this.current?.work.job === job ? this.current.work.legIds : [];
    return {
      id: job.id,
      card: job.card,
      sound: job.sound,
      label: job.label,
      sourceId: job.sourceId,
      totalBytes: job.totalBytes,
      fileCount: job.files.length,
      queued: !job.legs.some((leg) => leg.live) && job.legs.filter((leg) => !leg.relay).every((leg) => leg.outcomes.size === 0),
      running: runningLegs.length > 0,
      checksum: job.checksum,
      legs: job.legs.map((leg) => this.legSnapshot(job, leg)),
      bytesPerSecond: job.bytesPerSecond,
      etaSeconds: job.etaSeconds,
      currentFile: job.currentFile,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      clearedAt: job.clearedAt,
      workflow: this.workflows().find((workflow) => workflow.id === job.workflow)?.name ?? null,
      followUp: job.followUp,
    };
  }

  private legSnapshot(job: Job, leg: Leg): LegSnapshot {
    const base = {
      id: leg.plan.id,
      name: leg.plan.name,
      targetDir: leg.plan.targetDir,
      relay: leg.relay,
      local: leg.local,
      relayFrom: job.legs.find((other) => other.plan.id === leg.relayFrom)?.plan.name ?? null,
      waiting: null as string | null,
      bytesPerSecond: leg.bytesPerSecond,
      etaSeconds: leg.etaSeconds,
      currentFile: leg.currentFile,
    };
    const pct = (part: number, whole: number) => (whole > 0 ? Math.min(100, (part / whole) * 100) : 100);
    if (leg.live) {
      // An upload that carried on from earlier counts what it already sent.
      const whole = leg.baseBytes + leg.live.totalBytes;
      return {
        ...base,
        copyPct: pct(leg.baseBytes + leg.live.copiedBytes, whole),
        verifyPct: leg.live.phase === 'copying' ? 0 : pct(leg.baseBytes + leg.live.verifiedBytes, whole),
        failed: leg.live.error !== null,
        error: leg.live.error,
        problemFiles: leg.live.problemFiles,
      };
    }
    const failures = [...leg.outcomes.values()].filter((outcome) => outcome.state === 'failed');
    const decided = leg.outcomes.size > 0;
    const pending = job.files.filter((file) => !leg.outcomes.has(file.path));
    if ((!decided || pending.length > 0) && !leg.error) {
      if (!leg.relay) return { ...base, copyPct: 0, verifyPct: 0, failed: false, error: null, problemFiles: 0 };
      const sent = job.totalBytes - pending.reduce((sum, file) => sum + file.size, 0);
      const cardCopying = this.current?.work.job === job || this.queue.some((work) => work.job === job);
      return {
        ...base,
        copyPct: pct(sent, job.totalBytes),
        verifyPct: pct(sent, job.totalBytes),
        failed: false,
        error: null,
        problemFiles: failures.length,
        waiting:
          leg.waiting ??
          (this.settings.relaysPaused ? 'Paused' : cardCopying ? 'Starts once the card has verified on a backup.' : 'Waiting its turn.'),
      };
    }
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
