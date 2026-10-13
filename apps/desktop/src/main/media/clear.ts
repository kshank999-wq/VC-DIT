import { readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ClearCheck } from '../../shared/media';
import type { FormatRule } from '../../shared/project';
import { listSource, type FileOutcome, type SourceFile } from './transfer';

/**
 * Clearing a card for camera (spec §8, as amended): only after a fresh
 * check that everything on it is safely elsewhere, and then only the files
 * that were ingested. Nothing else on the card is touched, and a card
 * holding anything that was not backed up is not cleared at all.
 *
 * The check, made again immediately before anything is erased:
 * - the card holds exactly the files that were copied (same names, sizes
 *   and times); a new clip, or a changed one, stops it;
 * - the copies the production's rule relies on (two local copies, or every
 *   destination) all verified at ingest, and are still there now, at the
 *   same size;
 * - under the two-local rule there are at least two of them (a drive on the
 *   cart copied from the backup, a cascade, counts; an upload does not).
 */

export interface ClearLeg {
  name: string;
  targetDir: string;
  relay: boolean;
  /** A drive on the cart: copied from the backup (a cascade), it still counts as a local copy. */
  local?: boolean;
  outcomes: Map<string, FileOutcome>;
}

const VERIFIED = new Set(['verified', 'already-there']);
const split = (path: string) => path.split('/');
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

export const checkClear = async (input: { card: string; sourceRoot: string; files: SourceFile[]; legs: ClearLeg[]; rule: FormatRule }): Promise<ClearCheck> => {
  const problems: string[] = [];
  // Local copies: straight from the card, or cascaded from the backup to another drive on the cart (checked against the card's checksums).
  const counted = input.rule === 'every' ? input.legs : input.legs.filter((leg) => !leg.relay || leg.local);
  if (input.rule === 'two-local' && counted.length < 2) problems.push('Only one local copy. This production needs two verified local copies before a card is cleared.');

  // The card: exactly what was copied, nothing new, nothing changed.
  let onCard: SourceFile[] = [];
  try {
    onCard = (await listSource(input.sourceRoot)).files;
  } catch {
    problems.push(`${input.card} cannot be read.`);
  }
  // By where each file is on the card: its copies may have been named after the card.
  const ingested = new Map(input.files.map((file) => [file.source ?? file.path, file]));
  const extra = onCard.filter((file) => !ingested.has(file.path));
  const changed = onCard.filter((file) => {
    const before = ingested.get(file.path);
    return before && (before.size !== file.size || Math.abs(before.mtimeMs - file.mtimeMs) > 2000);
  });
  if (extra.length) problems.push(`${plural(extra.length, 'file')} on the card ${extra.length === 1 ? 'was' : 'were'} not part of this ingest (new clips?), e.g. ${extra[0]!.path}. Ingest the card again before clearing it.`);
  if (changed.length) problems.push(`${plural(changed.length, 'file')} on the card changed since ${changed.length === 1 ? 'it was' : 'they were'} copied, e.g. ${changed[0]!.path}. Ingest the card again before clearing it.`);
  const present = onCard.filter((file) => ingested.has(file.path));

  // Each copy relied on: verified at ingest, and still there now.
  const copies: ClearCheck['copies'] = [];
  for (const leg of counted) {
    let unverified = 0;
    let missing = 0;
    for (const file of input.files) {
      if (!VERIFIED.has(leg.outcomes.get(file.path)?.state ?? '')) {
        unverified += 1;
        continue;
      }
      const size = await stat(join(leg.targetDir, ...split(file.path))).then((info) => info.size, () => -1);
      if (size !== file.size) missing += 1;
    }
    const problem = unverified
      ? `${plural(unverified, 'file')} did not verify here.`
      : missing
        ? `${missing.toLocaleString('en-US')} cop${missing === 1 ? 'y' : 'ies'} missing or a different size now. Is the drive plugged in?`
        : null;
    copies.push({ name: leg.name, ok: problem === null, problem, files: input.files.length - unverified - missing });
    if (problem) problems.push(`${leg.name}: ${problem}`);
  }

  return {
    ok: problems.length === 0,
    card: input.card,
    files: present.length,
    bytes: present.reduce((sum, file) => sum + file.size, 0),
    copies,
    problems,
    checkedAt: new Date().toISOString(),
  };
};

/**
 * Erase the ingested files from the card, then any folders that are left
 * empty (never the card's root). Only paths from the ingest are touched.
 */
export const clearCardFiles = async (sourceRoot: string, files: SourceFile[]): Promise<{ removed: number; failed: { path: string; error: string }[] }> => {
  let removed = 0;
  const failed: { path: string; error: string }[] = [];
  const folders = new Set<string>();
  for (const file of files) {
    // The file as it is on the card, whatever its copies are called.
    const onCard = file.source ?? file.path;
    const path = join(sourceRoot, ...split(onCard));
    try {
      await unlink(path);
      removed += 1;
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (code !== 'ENOENT') failed.push({ path: onCard, error: cause instanceof Error ? cause.message : String(cause) });
    }
    for (let dir = dirname(onCard); dir && dir !== '.'; dir = dirname(dir)) folders.add(dir);
  }
  // Deepest first, so a folder's empty subfolders go before it.
  for (const dir of [...folders].sort((a, b) => b.split('/').length - a.split('/').length)) {
    const path = join(sourceRoot, ...split(dir));
    const left = await readdir(path).catch(() => null);
    // Only truly empty folders, apart from the system's own clutter files.
    if (left && left.every((name) => name === '.DS_Store' || name.startsWith('._'))) {
      for (const name of left) await unlink(join(path, name)).catch(() => undefined);
      await rmdir(path).catch(() => undefined);
    }
  }
  return { removed, failed };
};
