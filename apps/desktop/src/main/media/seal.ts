import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChecksumMethod, SealOutcome } from '../../shared/media';
import { createHasher, prepareChecksums } from './checksum';
import { segment } from './rules';
import { listSource, type SourceFile } from './transfer';

/**
 * Sealing a drive before it leaves set (a shuttle to post, an archive to the
 * vault): every file the production says was copied to it and verified, on
 * every day, checked against what is on the drive now.
 *
 * - present: there, at the size it was copied at (and, when asked, read back
 *   in full with the same checksum it was copied with);
 * - missing or changed: the drive is not what the production thinks it is,
 *   and it is not sealed;
 * - added: on the drive in a card folder, but not in the production — noted,
 *   not a reason to refuse.
 *
 * A sealed drive gets a manifest in PRODUCTION/SEALS: a CSV of every file and
 * its checksum, and a JSON summary carrying the CSV's own SHA-256, so the
 * manifest itself can be checked at the other end.
 */

export interface SealExpected {
  day: number;
  card: string;
  /** The card's folder, relative to the drive's root, '/'-separated. */
  dir: string;
  /** The file within the card folder, '/'-separated. */
  path: string;
  size: number;
  hash: string | null;
  method: ChecksumMethod;
}

export interface SealProgress {
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  file: string | null;
}

const split = (path: string) => (path ? path.split('/') : []);
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const cell = (value: string | number) => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const stamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').replace('T', '_');

const hashFile = (path: string, method: ChecksumMethod, signal: AbortSignal | undefined, onBytes: (n: number) => void): Promise<string> =>
  new Promise((resolve, reject) => {
    const hasher = createHasher(method);
    const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 });
    const abort = () => stream.destroy(new Error('Stopped.'));
    signal?.addEventListener('abort', abort, { once: true });
    stream.on('data', (chunk) => {
      const bytes = chunk as Buffer;
      hasher.update(bytes);
      onBytes(bytes.length);
    });
    stream.on('error', (cause) => {
      signal?.removeEventListener('abort', abort);
      reject(cause);
    });
    stream.on('end', () => {
      signal?.removeEventListener('abort', abort);
      resolve(hasher.digest());
    });
  });

export async function sealDrive(options: {
  root: string;
  name: string;
  production: string;
  expected: SealExpected[];
  /** Read every file back and compare its checksum, not just its size. */
  verify: boolean;
  tool: { name: string; version: string };
  onProgress?: (progress: SealProgress) => void;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<SealOutcome> {
  const now = options.now ?? (() => new Date());
  // One entry per file on the drive: a card ingested twice to the same folder counts once, at its latest copy.
  const byKey = new Map<string, SealExpected>();
  for (const file of options.expected) byKey.set(`${file.dir}/${file.path}`, file);
  const expected = [...byKey.values()].sort((a, b) => a.day - b.day || a.dir.localeCompare(b.dir) || a.path.localeCompare(b.path));
  const totalBytes = expected.reduce((sum, file) => sum + file.size, 0);
  const progress: SealProgress = { files: 0, totalFiles: expected.length, bytes: 0, totalBytes, file: null };

  const missing: string[] = [];
  const changed: { path: string; why: string }[] = [];
  const added: string[] = [];
  let unhashed = 0;
  const rows: { file: SealExpected; hash: string; readBack: boolean }[] = [];

  if (options.verify) await prepareChecksums();
  const dirs = [...new Set(expected.map((file) => file.dir))];
  for (const dir of dirs) {
    let onDrive: SourceFile[] | null = null;
    try {
      onDrive = (await listSource(join(options.root, ...split(dir)))).files;
    } catch {
      // The whole card folder is gone: every file in it is missing.
    }
    const present = new Map((onDrive ?? []).map((file) => [file.path, file]));
    const wanted = expected.filter((file) => file.dir === dir);
    const wantedPaths = new Set(wanted.map((file) => file.path));
    for (const file of onDrive ?? []) if (!wantedPaths.has(file.path)) added.push(`${dir}/${file.path}`);

    for (const file of wanted) {
      if (options.signal?.aborted) throw new Error('Stopped.');
      const label = `${dir}/${file.path}`;
      const before = progress.bytes;
      progress.file = label;
      const there = present.get(file.path);
      if (!there) {
        missing.push(label);
      } else if (there.size !== file.size) {
        changed.push({ path: label, why: `${there.size.toLocaleString('en-US')} bytes now, ${file.size.toLocaleString('en-US')} when copied` });
      } else if (options.verify && file.hash) {
        try {
          const hash = await hashFile(join(options.root, ...split(dir), ...split(file.path)), file.method, options.signal, (n) => {
            progress.bytes += n;
            options.onProgress?.(progress);
          });
          if (hash === file.hash) rows.push({ file, hash, readBack: true });
          else changed.push({ path: label, why: `${file.method} does not match the copy (${hash.slice(0, 8)}… now, ${file.hash.slice(0, 8)}… then)` });
        } catch (cause) {
          if (options.signal?.aborted) throw new Error('Stopped.');
          changed.push({ path: label, why: `could not be read: ${cause instanceof Error ? cause.message : String(cause)}` });
        }
      } else {
        // No checksum was recorded at ingest: present at its size is all that can be said.
        if (options.verify) unhashed += 1;
        rows.push({ file, hash: file.hash ?? '', readBack: false });
      }
      progress.bytes = before + file.size;
      progress.files += 1;
      options.onProgress?.(progress);
    }
  }

  const problems: string[] = [];
  if (expected.length === 0) problems.push(`Nothing has been copied to ${options.name} in this production, so there is nothing to seal.`);
  if (missing.length) problems.push(`${plural(missing.length, 'file')} copied here ${missing.length === 1 ? 'is' : 'are'} not on the drive now, e.g. ${missing[0]}.`);
  if (changed.length) problems.push(`${plural(changed.length, 'file')} ${changed.length === 1 ? 'is' : 'are'} not as copied, e.g. ${changed[0]!.path}: ${changed[0]!.why}.`);

  const sealedAt = now();
  const outcome: SealOutcome = {
    ok: problems.length === 0,
    name: options.name,
    root: options.root,
    files: expected.length,
    bytes: totalBytes,
    verified: options.verify,
    missing,
    changed,
    added,
    unhashed,
    problems,
    checkedAt: sealedAt.toISOString(),
    manifest: null,
  };
  if (!outcome.ok) return outcome;

  // The manifest: every file and its checksum, then a summary that names the CSV's own SHA-256.
  const csv = [
    'Day,Card,Path,Size,Method,Checksum,Checked',
    ...rows.map(({ file, hash, readBack }) =>
      [file.day, file.card, `${file.dir}/${file.path}`, file.size, file.method, hash, readBack ? 'read back' : 'size'].map(cell).join(','),
    ),
    '',
  ].join('\n');
  const folder = join(options.root, segment(options.production), 'SEALS');
  const base = `SEAL_${segment(options.name)}_${stamp(sealedAt)}`;
  const summary = {
    schema: 'vc-dit.seal/1',
    tool: options.tool,
    production: options.production,
    drive: options.name,
    sealedAt: outcome.checkedAt,
    files: expected.length,
    bytes: totalBytes,
    checked: options.verify ? 'every file read back and its checksum compared' : 'every file present at its copied size',
    notInProduction: added,
    unhashed,
    manifest: { file: `${base}.csv`, sha256: createHash('sha256').update(csv).digest('hex') },
  };
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${base}.csv`), csv, 'utf8');
    await writeFile(join(folder, `${base}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  } catch (cause) {
    return { ...outcome, ok: false, problems: [`The seal could not be written to ${options.name}: ${cause instanceof Error ? cause.message : String(cause)}`] };
  }
  return { ...outcome, manifest: join(folder, `${base}.csv`) };
}
