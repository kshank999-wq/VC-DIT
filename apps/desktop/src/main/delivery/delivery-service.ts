import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DELIVERY_PACKAGES,
  deliveryHeadroom,
  deliveryNeed,
  deliveryParts,
  type DeliveryPackageId,
  type DeliveryPartId,
  type DeliveryPlace,
  type DeliveryState,
} from '../../shared/project';
import type { DeliveryFile, ProductionDb, StoredDelivery } from '../db/production-db';
import type { ReportContext, WrittenReports } from '../media/reports';
import { segment } from '../media/rules';
import type { LegPlan, SourceFile, TransferProgress, TransferResult } from '../media/transfer';
import type { WorkerPlan } from '../media/transfer-worker';
import { editorialAle, editorialCsv } from './editorial';
import { dayDir, listPart, scanInventory, type Inventory, type Place } from './inventory';

/**
 * End-of-day delivery (spec §4.10). The chosen packages go from wherever the
 * day's material is to every chosen destination, through the same verified
 * copy as ingest: read once, written everywhere, each copy read back and
 * checked before it gets its real name, nothing ever overwritten. Originals
 * are also checked against the checksum they were ingested with, so a copy
 * that has gone bad on the RAID is caught rather than passed on.
 *
 * Every destination gets an ASC MHL of what it received and CSV/JSON logs
 * in REPORTS/delivery; the production database keeps the manifest, with
 * each file that did not verify, so a retry copies those files alone.
 */

export type RunTransfer = (
  plan: WorkerPlan,
  options?: {
    signal?: AbortSignal;
    onProgress?: (progress: TransferProgress) => void;
  },
) => Promise<{ result: TransferResult; reports: WrittenReports[] }>;

export interface DeliveryDeps {
  db: () => ProductionDb;
  /** Destination volumes and folders the media engine knows. */
  places: () => Place[];
  runTransfer: RunTransfer;
  tool: { name: string; version: string };
  changed: () => void;
}

/** Files a package copies from one place. */
interface Group {
  pkg: DeliveryPackageId;
  sourceId: string;
  source: string;
  dir: string;
  files: SourceFile[];
}

const stamp = (date: Date) =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')
    .replace('T', '_');
const csvCell = (value: string | number | null) => {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const bytesOf = (files: { size: number }[]) => files.reduce((sum, file) => sum + file.size, 0);
const MAX_PROBLEMS = 20;
const MAX_FAILED_KEPT = 20000;

/** The manifest as a CSV: one row per package per destination. */
export const manifestCsv = (records: StoredDelivery[]): string => {
  const header = [
    'package',
    'source',
    'destination',
    'files',
    'bytes',
    'verified',
    'already_there',
    'failed',
    'retries',
    'started',
    'finished',
    'mhl',
    'problems',
  ];
  const rows = records.map((record) => [
    record.packageName,
    record.source,
    record.destination,
    record.files,
    record.bytes,
    record.verified,
    record.alreadyThere,
    record.failed,
    record.retries,
    record.startedAt,
    record.finishedAt,
    record.mhl,
    record.problems.map((problem) => `${problem.path}: ${problem.error}`).join(' | '),
  ]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
};

export class DeliveryService {
  activity: DeliveryState['activity'] = null;
  private error: string | null = null;
  private inventory: (Inventory & { key: string; at: string }) | null = null;
  private scanning: Promise<void> | null = null;
  private again = false;
  private controller: AbortController | null = null;
  private running: Promise<unknown> | null = null;
  private lastTick = 0;

  constructor(private readonly deps: DeliveryDeps) {}

  busy(): boolean {
    return this.controller !== null;
  }

  stop(): void {
    this.controller?.abort();
  }

  /** Waits for a delivery in progress to end (quitting). */
  async idle(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  /** The drives as last looked through, if that was this production's open day. */
  view(): Pick<DeliveryState, 'places' | 'parts' | 'scanning' | 'scannedAt' | 'activity' | 'error'> {
    const current = this.inventory?.key === this.key() ? this.inventory : null;
    return {
      places: current?.places ?? [],
      parts: (current?.parts ?? []).map(({ dir: _dir, list: _list, ...part }) => part),
      scanning: this.scanning !== null,
      scannedAt: current?.at ?? null,
      activity: this.activity,
      error: this.error,
    };
  }

  private key() {
    const db = this.deps.db();
    return `${db.file}|${db.currentDay().number}`;
  }

  /** Every place: the engine's destinations and the folders added here. */
  private places(): Place[] {
    const places = [...this.deps.places()];
    for (const folder of this.deps.db().deliverySettings().folders) {
      if (!places.some((place) => place.id === folder.id || place.root === folder.path))
        places.push({
          id: folder.id,
          name: folder.name,
          kind: 'Folder',
          root: folder.path,
        });
    }
    return places;
  }

  /** Look through the drives again. Calls during a look are answered by one more look after it. */
  refresh(): Promise<void> {
    if (this.scanning) {
      this.again = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      try {
        do {
          this.again = false;
          const db = this.deps.db();
          const key = this.key();
          const day = db.currentDay();
          const production = db.production();
          const found = await scanInventory(this.places(), { production, day });
          if (this.key() === key) this.inventory = { ...found, key, at: new Date().toISOString() };
        } while (this.again);
      } catch {
        // A drive that cannot be read now: keep what was found before.
      } finally {
        this.scanning = null;
        this.deps.changed();
      }
    })();
    this.deps.changed();
    return this.scanning;
  }

  /** Check the delivery can go, then start it; the windows follow its progress. */
  async start(): Promise<void> {
    if (this.busy()) throw new Error('A delivery is already running.');
    const db = this.deps.db();
    const settings = db.deliverySettings();
    const parts = deliveryParts(settings.packages);
    if (parts.length === 0) throw new Error('Choose at least one package.');
    await this.refresh();
    const inventory = this.inventory!;
    const targets = settings.destinations
      .map((id) => inventory.places.find((place) => place.id === id))
      .filter((place): place is DeliveryPlace => Boolean(place));
    if (targets.length === 0) throw new Error('Choose at least one destination.');
    const offline = targets.filter((place) => place.freeBytes === null);
    if (offline.length) throw new Error(`${offline.map((place) => place.name).join(', ')} cannot be reached. Connect it or choose another destination.`);
    const short = targets.filter((place) => place.freeBytes! - deliveryNeed(inventory, settings.packages, place.id) < deliveryHeadroom(place.totalBytes ?? 0));
    if (short.length) throw new Error(`Not enough space on ${short.map((place) => place.name).join(', ')}. Deselect a package or choose another destination.`);

    const day = db.currentDay();
    const production = db.production();
    const ref = { production, day };
    // The editorial lists are written fresh, beside the originals they describe, and delivered with them.
    if (parts.includes('editorial')) {
      const part = inventory.parts.find((candidate) => candidate.id === 'editorial')!;
      const home =
        part.sourceId ??
        inventory.parts.find((candidate) => candidate.id === 'camera')?.sourceId ??
        inventory.places.find((place) => place.freeBytes !== null)?.id;
      const place = inventory.places.find((candidate) => candidate.id === home);
      if (place) {
        const dir = join(dayDir(place.root, ref), 'EDITORIAL');
        const rows = db.editorialRows(day.number);
        const base = join(dir, `${segment(production.code || production.name)}_D${String(day.number).padStart(3, '0')}_${stamp(new Date())}`);
        await mkdir(dir, { recursive: true });
        await writeFile(`${base}.ale`, editorialAle(rows, production.frameRate), 'utf8');
        await writeFile(`${base}_sync.csv`, editorialCsv(rows), 'utf8');
        const list = await listPart(dayDir(place.root, ref), 'editorial');
        Object.assign(part, {
          sourceId: place.id,
          source: place.name,
          dir: dayDir(place.root, ref),
          list,
          files: list.length,
          bytes: bytesOf(list),
        });
      }
    }

    // Each part goes with the first chosen package that has it, so a part two packages share is copied once.
    const expected = db.ingestHashes(day.number, production.checksum);
    const taken = new Set<DeliveryPartId>();
    const groups: Group[] = [];
    for (const pkg of DELIVERY_PACKAGES) {
      if (!settings.packages.includes(pkg.id)) continue;
      for (const id of pkg.parts) {
        if (taken.has(id)) continue;
        taken.add(id);
        const part = inventory.parts.find((candidate) => candidate.id === id);
        if (!part?.sourceId || !part.dir || part.list.length === 0) continue;
        const files = part.list.map((file) => ({
          ...file,
          expected: expected.get(file.path) ?? null,
        }));
        const group = groups.find((candidate) => candidate.pkg === pkg.id && candidate.sourceId === part.sourceId);
        if (group) group.files.push(...files);
        else
          groups.push({
            pkg: pkg.id,
            sourceId: part.sourceId,
            source: part.source!,
            dir: part.dir,
            files,
          });
      }
    }
    if (groups.length === 0) throw new Error('None of the chosen packages has anything on the drives for this day yet.');

    this.controller = new AbortController();
    this.error = null;
    const signal = this.controller.signal;
    this.running = this.work(db, day.number, ref, production.checksum, targets, groups, signal)
      .catch((cause) => (this.error = cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        this.controller = null;
        this.activity = null;
      })
      // What is where has changed: look again.
      .then(() => this.refresh());
  }

  private async work(
    db: ProductionDb,
    day: number,
    ref: Parameters<typeof dayDir>[1],
    method: WorkerPlan['method'],
    targets: DeliveryPlace[],
    groups: Group[],
    signal: AbortSignal,
  ) {
    const totalBytes = groups.filter((group) => targets.some((place) => place.id !== group.sourceId)).reduce((sum, group) => sum + bytesOf(group.files), 0);
    let doneBytes = 0;
    for (const pkg of DELIVERY_PACKAGES) {
      const mine = groups.filter((group) => group.pkg === pkg.id);
      if (mine.length === 0) continue;
      const tallies = new Map<string, StoredDelivery>();
      for (const group of mine) {
        if (signal.aborted) break;
        const legs: LegPlan[] = targets
          .filter((place) => place.id !== group.sourceId)
          .map((place) => ({
            id: place.id,
            name: place.name,
            root: place.root,
            targetDir: dayDir(place.root, ref),
          }));
        if (legs.length === 0) continue;
        const startedAt = new Date().toISOString();
        const before = doneBytes;
        const groupBytes = bytesOf(group.files);
        this.activity = {
          label: `${pkg.name} from ${group.source}`,
          totalBytes,
          doneBytes,
          bytesPerSecond: 0,
        };
        this.deps.changed();
        const { result, reports } = await this.deps.runTransfer(this.plan(group.dir, group.files, legs, method, pkg.id), {
          signal,
          onProgress: (progress) => this.progress(before, progress, legs.length),
        });
        doneBytes = before + groupBytes;
        for (const leg of legs) {
          const tally = tallies.get(leg.id) ?? this.blank(pkg.id, leg, group.source, startedAt);
          // A package read from two drives names both.
          if (!tally.source.split(', ').includes(group.source)) tally.source = `${tally.source}, ${group.source}`;
          this.add(tally, result, leg.id, group.dir, reports.find((report) => report.legId === leg.id)?.mhl ?? null);
          tallies.set(leg.id, tally);
        }
      }
      for (const tally of tallies.values()) db.saveDelivery(day, tally);
      this.deps.changed();
    }
    await this.writeSummaries(db, day, ref, targets);
  }

  /** Try again the files of one package that did not verify on one destination. */
  async retry(pkg: DeliveryPackageId, destinationId: string): Promise<void> {
    if (this.busy()) throw new Error('A delivery is already running.');
    const db = this.deps.db();
    const day = db.currentDay();
    const record = db.deliveries(day.number).find((candidate) => candidate.package === pkg && candidate.destinationId === destinationId);
    if (!record || record.failedFiles.length === 0) throw new Error('Nothing to retry there.');
    try {
      await stat(record.root);
    } catch {
      throw new Error(`${record.destination} cannot be reached. Connect it first.`);
    }
    const ref = { production: db.production(), day };
    const leg: LegPlan = {
      id: destinationId,
      name: record.destination,
      root: record.root,
      targetDir: dayDir(record.root, ref),
    };
    const name = DELIVERY_PACKAGES.find((candidate) => candidate.id === pkg)?.name ?? pkg;
    this.controller = new AbortController();
    this.error = null;
    const signal = this.controller.signal;
    this.running = (async () => {
      const roots = [...new Set(record.failedFiles.map((file) => file.root))];
      const totalBytes = bytesOf(record.failedFiles);
      const next: StoredDelivery = {
        ...record,
        failed: 0,
        problems: [],
        failedFiles: [],
        retries: record.retries + 1,
      };
      let doneBytes = 0;
      for (const root of roots) {
        if (signal.aborted) break;
        const files = record.failedFiles.filter((file) => file.root === root).map(({ root: _root, ...file }) => file);
        const before = doneBytes;
        this.activity = {
          label: `Retrying ${name} on ${record.destination}`,
          totalBytes,
          doneBytes,
          bytesPerSecond: 0,
        };
        this.deps.changed();
        try {
          const { result, reports } = await this.deps.runTransfer(this.plan(root, files, [leg], ref.production.checksum, pkg), {
            signal,
            onProgress: (progress) => this.progress(before, progress, 1, totalBytes),
          });
          this.add(next, result, leg.id, root, reports[0]?.mhl ?? null, true);
        } catch (cause) {
          // That source is gone: its files stay failed.
          next.failed += files.length;
          const error = cause instanceof Error ? cause.message : String(cause);
          next.failedFiles.push(
            ...files.map((file) => ({
              ...file,
              root,
              expected: file.expected ?? null,
            })),
          );
          next.problems.push(...files.slice(0, MAX_PROBLEMS - next.problems.length).map((file) => ({ path: file.path, error })));
        }
        doneBytes = before + bytesOf(files);
      }
      next.finishedAt = new Date().toISOString();
      if (this.deps.db() === db) db.saveDelivery(day.number, next);
      await this.writeSummaries(db, day.number, ref, [
        {
          id: destinationId,
          name: record.destination,
          kind: '',
          root: record.root,
          freeBytes: null,
          totalBytes: null,
        },
      ]);
    })()
      .catch((cause) => (this.error = cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        this.controller = null;
        this.activity = null;
      })
      .then(() => this.refresh());
  }

  private plan(sourceRoot: string, files: SourceFile[], legs: LegPlan[], method: WorkerPlan['method'], pkg: DeliveryPackageId): WorkerPlan {
    const contexts: Record<string, ReportContext> = Object.fromEntries(
      legs.map((leg) => [
        leg.id,
        {
          card: `DELIVERY_${pkg.toUpperCase()}`,
          tool: this.deps.tool,
          reportsDir: join(leg.targetDir, 'REPORTS', 'delivery'),
        },
      ]),
    );
    return { sourceRoot, files, legs, allLegs: legs, method, contexts };
  }

  private progress(before: number, progress: TransferProgress, legCount: number, total?: number) {
    if (!this.activity) return;
    const verified = Object.values(progress.legs).reduce((sum, leg) => sum + leg.verifiedBytes, 0) / Math.max(1, legCount);
    this.activity = {
      ...this.activity,
      totalBytes: total ?? this.activity.totalBytes,
      doneBytes: before + (progress.sourceBytesRead + verified) / 2,
      bytesPerSecond: progress.bytesPerSecond,
    };
    // The whole state goes to the windows: once a second is plenty.
    const now = Date.now();
    if (now - this.lastTick >= 1000) {
      this.lastTick = now;
      this.deps.changed();
    }
  }

  private blank(pkg: DeliveryPackageId, leg: LegPlan, source: string, startedAt: string): StoredDelivery {
    return {
      package: pkg,
      packageName: DELIVERY_PACKAGES.find((candidate) => candidate.id === pkg)?.name ?? pkg,
      destinationId: leg.id,
      destination: leg.name,
      root: leg.root,
      source,
      files: 0,
      bytes: 0,
      verified: 0,
      alreadyThere: 0,
      failed: 0,
      retries: 0,
      startedAt,
      finishedAt: startedAt,
      problems: [],
      failedFiles: [],
      mhl: null,
    };
  }

  /** Count one copy's outcome on one destination into its record. A retry only re-counts the files it tried. */
  private add(record: StoredDelivery, result: TransferResult, legId: string, root: string, mhl: string | null, retry = false) {
    if (!retry) {
      record.files += result.files.length;
      record.bytes += bytesOf(result.files);
    }
    for (const file of result.files) {
      const outcome = file.legs[legId];
      if (outcome?.state === 'verified') record.verified += 1;
      else if (outcome?.state === 'already-there') record.alreadyThere += 1;
      else {
        record.failed += 1;
        if (record.problems.length < MAX_PROBLEMS)
          record.problems.push({
            path: file.path,
            error: outcome?.error ?? 'Did not verify.',
          });
        if (record.failedFiles.length < MAX_FAILED_KEPT) {
          const kept: DeliveryFile = {
            root,
            path: file.path,
            size: file.size,
            mtimeMs: file.mtimeMs,
            expected: file.expected ?? null,
          };
          record.failedFiles.push(kept);
        }
      }
    }
    record.finishedAt = result.finishedAt;
    record.mhl = mhl ?? record.mhl;
  }

  /** The day's delivery manifest for each destination, beside its other reports. */
  private async writeSummaries(db: ProductionDb, day: number, ref: Parameters<typeof dayDir>[1], targets: DeliveryPlace[]) {
    if (this.deps.db() !== db) return;
    const records = db.deliveries(day);
    const now = new Date();
    for (const target of targets) {
      const mine = records.filter((record) => record.destinationId === target.id);
      if (mine.length === 0) continue;
      try {
        await stat(target.root);
        const dir = join(dayDir(target.root, ref), 'REPORTS', 'delivery');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `DELIVERY_MANIFEST_${stamp(now)}.csv`), manifestCsv(mine), 'utf8');
      } catch {
        // That destination has gone; its records stay in the production.
      }
    }
  }
}
