import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChecksumMethod } from '../../shared/media';
import { createHasher, prepareChecksums } from './checksum';

/**
 * The verified copy (spec §4.3, §8): one card to every destination at once.
 *
 * - The card is read once. Each chunk is hashed and written to every
 *   destination in the same pass, so a three-way copy costs one read.
 * - The card is opened read-only. Nothing on it is renamed, moved, written
 *   or deleted, ever.
 * - Each destination's copy is written as `<name>.vcdit-part` and only gets
 *   its real name after it has been read back and its checksum matched the
 *   card's. A file under its real name has passed; a failed copy never sits
 *   there looking finished.
 * - A file already at a destination under the same name is never
 *   overwritten. If it matches the card, it counts as verified ("already
 *   there", which makes a re-run resume a card); if not, it is a failure.
 * - A destination that is unplugged mid-copy stops cleanly: the engine
 *   checks before each file that the destination is still the same disk, so
 *   it can never fall through and fill the boot drive's /Volumes folder.
 *
 * The only files this ever deletes are its own `.vcdit-part` files.
 */

export const PART_SUFFIX = '.vcdit-part';

export interface SourceFile {
  /** Relative to the card's root, with `/` separators. */
  path: string;
  size: number;
  mtimeMs: number;
}

/** One destination: the folder this card's files go into. */
export interface LegPlan {
  id: string;
  name: string;
  /** The destination itself (a volume's mount, a chosen folder). Must exist; never created. */
  root: string;
  /** The card's folder on it, under `root`. Created as needed. */
  targetDir: string;
}

export interface FileOutcome {
  state: 'verified' | 'already-there' | 'failed';
  error?: string;
}

export interface FileRecord extends SourceFile {
  /** The card's checksum, from the copy pass; null when the card could not be read. */
  sourceHash: string | null;
  hashedAt: string | null;
  legs: Record<string, FileOutcome>;
}

export interface LegProgress {
  phase: 'copying' | 'verifying' | 'done';
  totalBytes: number;
  copiedBytes: number;
  verifiedBytes: number;
  problemFiles: number;
  /** Why this destination stopped, if it did. */
  error: string | null;
}

export interface TransferProgress {
  totalBytes: number;
  sourceBytesRead: number;
  bytesPerSecond: number;
  legs: Record<string, LegProgress>;
}

export interface TransferResult {
  method: ChecksumMethod;
  startedAt: string;
  finishedAt: string;
  stopped: boolean;
  files: FileRecord[];
  legs: Record<string, LegProgress>;
}

export interface TransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
  progressEveryMs?: number;
  chunkBytes?: number;
  /** Test seam: runs between the copy and the read-back of each destination file. */
  afterCopy?: (legId: string, written: string, file: SourceFile) => Promise<void>;
}

// ---------------------------------------------------------------- listing a card

const IGNORED = new Set([
  '.DS_Store',
  '.Spotlight-V100',
  '.Trashes',
  '.fseventsd',
  '.TemporaryItems',
  '.DocumentRevisions-V100',
  'System Volume Information',
  '$RECYCLE.BIN',
  'Thumbs.db',
  'desktop.ini',
  // ASC MHL keeps its history in this folder; each destination gets its own.
  'ascmhl',
]);

/** Operating-system clutter and the engine's own leftovers: not media, not copied. */
export const isIgnored = (name: string): boolean => IGNORED.has(name) || name.startsWith('._') || name.endsWith(PART_SUFFIX);

/** Every file on the card, in a stable order. Symbolic links are listed as skipped, not followed. */
export const listSource = async (root: string): Promise<{ files: SourceFile[]; skipped: string[] }> => {
  const files: SourceFile[] = [];
  const skipped: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(root, ...splitPath(relative)), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const info = await stat(join(root, ...splitPath(path)));
        files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      } else skipped.push(path);
    }
  };
  await walk('');
  return { files, skipped };
};

const splitPath = (relative: string): string[] => (relative ? relative.split('/') : []);

// ---------------------------------------------------------------- the transfer

/** Errors that mean the destination as a whole is gone or full, not just one file. */
const FATAL = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'ENODEV', 'ENXIO', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOENT']);

const codeOf = (cause: unknown): string => (cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : '');

const describe = (cause: unknown): string => {
  switch (codeOf(cause)) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'The destination is full.';
    case 'EROFS':
      return 'The destination is read-only.';
    case 'EACCES':
    case 'EPERM':
      return 'No permission to write to the destination.';
    case 'EIO':
    case 'ENODEV':
    case 'ENXIO':
    case 'ENOENT':
    case 'ENOTDIR':
      return 'The destination stopped responding or was disconnected.';
    default:
      return cause instanceof Error ? cause.message : String(cause);
  }
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (codeOf(cause) === 'ENOENT') return false;
    throw cause;
  }
};

const deviceOf = async (path: string): Promise<number | null> => {
  try {
    return (await stat(path)).dev;
  } catch {
    return null;
  }
};

const removePart = async (path: string) => {
  try {
    await unlink(path);
  } catch {
    // Already gone, or the destination is: nothing left to clean.
  }
};

type LegFile = { kind: 'pending' } | { kind: 'part' } | { kind: 'existing' } | { kind: 'done'; outcome: FileOutcome };

interface LegRun {
  plan: LegPlan;
  device: number | null;
  progress: LegProgress;
  files: LegFile[];
}

const STOPPED = 'Stopped before it was verified.';

export const runTransfer = async (
  sourceRoot: string,
  files: SourceFile[],
  plans: LegPlan[],
  method: ChecksumMethod,
  options: TransferOptions = {},
): Promise<TransferResult> => {
  await prepareChecksums();
  const startedAt = new Date().toISOString();
  const chunkBytes = options.chunkBytes ?? 8 * 1024 * 1024;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const sourceDevice = await deviceOf(sourceRoot);
  const records: FileRecord[] = files.map((file) => ({ ...file, sourceHash: null, hashedAt: null, legs: {} }));
  const target = (leg: LegRun, file: SourceFile) => join(leg.plan.targetDir, ...splitPath(file.path));

  const legs: LegRun[] = [];
  for (const plan of plans) {
    const device = await deviceOf(plan.root);
    legs.push({
      plan,
      device,
      progress: { phase: 'copying', totalBytes, copiedBytes: 0, verifiedBytes: 0, problemFiles: 0, error: device === null ? 'The destination is not available.' : null },
      files: files.map(() => ({ kind: 'pending' })),
    });
  }

  // ------------------------------------------------ progress
  let sourceBytesRead = 0;
  let bytesPerSecond = 0;
  let lastAt = Date.now();
  let lastBytes = 0;
  const report = (force = false) => {
    if (!options.onProgress) return;
    const now = Date.now();
    if (!force && now - lastAt < (options.progressEveryMs ?? 250)) return;
    const seconds = (now - lastAt) / 1000;
    if (seconds > 0) {
      const instant = (sourceBytesRead - lastBytes) / seconds;
      bytesPerSecond = bytesPerSecond === 0 ? instant : bytesPerSecond * 0.7 + instant * 0.3;
    }
    lastAt = now;
    lastBytes = sourceBytesRead;
    options.onProgress({ totalBytes, sourceBytesRead, bytesPerSecond, legs: Object.fromEntries(legs.map((leg) => [leg.plan.id, { ...leg.progress }])) });
  };

  const finish = (leg: LegRun, index: number, outcome: FileOutcome) => {
    leg.files[index] = { kind: 'done', outcome };
    if (outcome.state === 'failed') leg.progress.problemFiles += 1;
  };

  /** Stop a destination for good: everything not yet verified on it fails with the reason. */
  const kill = async (leg: LegRun, reason: string) => {
    if (!leg.progress.error) leg.progress.error = reason;
    for (const [index, state] of leg.files.entries()) {
      if (state.kind === 'done') continue;
      if (state.kind === 'part') await removePart(target(leg, files[index]!) + PART_SUFFIX);
      finish(leg, index, { state: 'failed', error: reason });
    }
  };
  for (const leg of legs) if (leg.progress.error) await kill(leg, leg.progress.error);

  const alive = (leg: LegRun) => leg.progress.error === null;
  /** Same disk as at the start, so a vanished mount point is never written into. */
  const stillThere = async (leg: LegRun): Promise<boolean> => {
    if (!alive(leg)) return false;
    if ((await deviceOf(leg.plan.root)) === leg.device) return true;
    await kill(leg, 'The destination was disconnected.');
    return false;
  };

  const stopped = () => options.signal?.aborted === true;

  // ------------------------------------------------ copy: read the card once, write everywhere
  const buffers = [Buffer.allocUnsafe(chunkBytes), Buffer.allocUnsafe(chunkBytes)];

  for (const [index, file] of files.entries()) {
    if (stopped()) break;
    const record = records[index]!;

    if ((await deviceOf(sourceRoot)) !== sourceDevice) {
      for (const leg of legs) if (leg.files[index]!.kind === 'pending') finish(leg, index, { state: 'failed', error: 'The card was removed.' });
      continue;
    }

    // Which destinations need this file written, and which already have one by that name.
    const writers: { leg: LegRun; handle: FileHandle; part: string }[] = [];
    for (const leg of legs) {
      if (!(await stillThere(leg))) continue;
      const final = target(leg, file);
      try {
        if (await exists(final)) {
          leg.files[index] = { kind: 'existing' };
          leg.progress.copiedBytes += file.size;
          continue;
        }
        await mkdir(dirname(final), { recursive: true });
        const part = final + PART_SUFFIX;
        writers.push({ leg, handle: await open(part, 'w'), part });
      } catch (cause) {
        if (FATAL.has(codeOf(cause))) await kill(leg, describe(cause));
        else finish(leg, index, { state: 'failed', error: describe(cause) });
      }
    }

    const dropWriter = async (writer: (typeof writers)[number], cause: unknown) => {
      await writer.handle.close().catch(() => undefined);
      await removePart(writer.part);
      writers.splice(writers.indexOf(writer), 1);
      if (FATAL.has(codeOf(cause))) await kill(writer.leg, describe(cause));
      else finish(writer.leg, index, { state: 'failed', error: describe(cause) });
    };

    const hasher = createHasher(method);
    let source: FileHandle | null = null;
    let readError: unknown = null;
    try {
      source = await open(join(sourceRoot, ...splitPath(file.path)), 'r');
      let which = 0;
      let current = await source.read(buffers[which]!, 0, chunkBytes, null);
      while (current.bytesRead > 0) {
        if (stopped()) break;
        const chunk = buffers[which]!.subarray(0, current.bytesRead);
        hasher.update(chunk);
        sourceBytesRead += chunk.length;
        // Write this chunk everywhere while the next one is read.
        const writes = writers.map(async (writer) => {
          let offset = 0;
          while (offset < chunk.length) offset += (await writer.handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
          writer.leg.progress.copiedBytes += chunk.length;
        });
        which = 1 - which;
        const next = source.read(buffers[which]!, 0, chunkBytes, null);
        // Awaited below; marked handled now so a failed read cannot crash the process while the writes finish.
        next.catch(() => undefined);
        const settled = await Promise.allSettled(writes);
        for (const [i, outcome] of [...settled.entries()].reverse()) {
          if (outcome.status === 'rejected') await dropWriter(writers[i]!, outcome.reason);
        }
        current = await next;
        report();
      }
      if (!stopped()) {
        record.sourceHash = hasher.digest();
        record.hashedAt = new Date().toISOString();
      }
    } catch (cause) {
      readError = cause;
    } finally {
      await source?.close().catch(() => undefined);
    }

    if (readError || stopped()) {
      const reason = stopped() ? STOPPED : `Could not read this file from the card: ${describe(readError)}`;
      for (const writer of [...writers]) {
        await writer.handle.close().catch(() => undefined);
        await removePart(writer.part);
        finish(writer.leg, index, { state: 'failed', error: reason });
      }
      for (const leg of legs) if (leg.files[index]!.kind === 'existing') finish(leg, index, { state: 'failed', error: reason });
      continue;
    }

    // Flush to the disk, then give each copy the card's modification time.
    for (const writer of [...writers]) {
      try {
        await writer.handle.sync();
        await writer.handle.close();
        const seconds = file.mtimeMs / 1000;
        await utimes(writer.part, seconds, seconds);
        writer.leg.files[index] = { kind: 'part' };
        if (options.afterCopy) await options.afterCopy(writer.leg.plan.id, writer.part, file);
      } catch (cause) {
        await dropWriter(writer, cause);
      }
    }
    report();
  }

  // ------------------------------------------------ verify: read every copy back, all destinations at once
  for (const leg of legs) leg.progress.phase = 'verifying';
  report(true);

  await Promise.all(
    legs.map(async (leg) => {
      const buffer = Buffer.allocUnsafe(chunkBytes);
      for (const [index, file] of files.entries()) {
        const state = leg.files[index]!;
        if (state.kind === 'done' || state.kind === 'pending') continue;
        if (stopped()) break;
        if (!(await stillThere(leg))) break;
        const record = records[index]!;
        const final = target(leg, file);
        const reading = state.kind === 'part' ? final + PART_SUFFIX : final;
        let hash: string;
        try {
          const hasher = createHasher(method);
          const handle = await open(reading, 'r');
          try {
            for (;;) {
              const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null);
              if (bytesRead === 0) break;
              hasher.update(buffer.subarray(0, bytesRead));
              leg.progress.verifiedBytes += bytesRead;
              report();
            }
          } finally {
            await handle.close();
          }
          hash = hasher.digest();
        } catch (cause) {
          if (state.kind === 'part') await removePart(reading);
          if (FATAL.has(codeOf(cause))) {
            await kill(leg, describe(cause));
            break;
          }
          finish(leg, index, { state: 'failed', error: `Could not read the copy back: ${describe(cause)}` });
          continue;
        }

        if (state.kind === 'existing') {
          finish(
            leg,
            index,
            hash === record.sourceHash
              ? { state: 'already-there' }
              : { state: 'failed', error: 'A different file with this name is already here. It was not overwritten.' },
          );
          continue;
        }
        if (hash !== record.sourceHash) {
          await removePart(reading);
          finish(leg, index, { state: 'failed', error: 'Checksum mismatch: the copy does not match the card.' });
          continue;
        }
        try {
          // Never over something that appeared while this file was being checked.
          if (await exists(final)) {
            await removePart(reading);
            finish(leg, index, { state: 'failed', error: 'A file with this name appeared during the copy. It was not overwritten.' });
          } else {
            await rename(reading, final);
            finish(leg, index, { state: 'verified' });
          }
        } catch (cause) {
          await removePart(reading);
          finish(leg, index, { state: 'failed', error: describe(cause) });
        }
      }
    }),
  );

  // Anything left undecided was stopped part-way.
  for (const leg of legs) {
    for (const [index, state] of leg.files.entries()) {
      if (state.kind === 'done') continue;
      if (state.kind === 'part') await removePart(target(leg, files[index]!) + PART_SUFFIX);
      finish(leg, index, { state: 'failed', error: leg.progress.error ?? STOPPED });
    }
    leg.progress.phase = 'done';
    // Bytes of files that failed never verify; show the bar full so the failure, not a stall, is what reads.
    leg.progress.copiedBytes = totalBytes;
    leg.progress.verifiedBytes = totalBytes;
  }
  for (const [index, record] of records.entries()) {
    for (const leg of legs) {
      const state = leg.files[index]!;
      if (state.kind === 'done') record.legs[leg.plan.id] = state.outcome;
    }
  }
  report(true);

  return {
    method,
    startedAt,
    finishedAt: new Date().toISOString(),
    stopped: stopped(),
    files: records,
    legs: Object.fromEntries(legs.map((leg) => [leg.plan.id, leg.progress])),
  };
};
