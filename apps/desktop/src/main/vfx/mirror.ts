import { link, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { ChecksumMethod } from '../../shared/media';
import type { MirrorMethod } from '../../shared/project';
import type { ReportContext, WrittenReports } from '../media/reports';
import { dayFolder, segment } from '../media/rules';
import type { LegPlan, SourceFile, TransferResult } from '../media/transfer';
import type { WorkerPlan } from '../media/transfer-worker';

/**
 * VFX mirroring (spec §4.9): a VFX shot's clip, already verified on a
 * destination, also appears under VFX → Scene → Setup → Take on that same
 * destination. The editorial copy in CAMERA_ORIGINALS is only ever read:
 * nothing here moves, renames or deletes it.
 *
 * - Hard link: the VFX folder's file is the same data on disk, so it costs no
 *   space. Needs the same drive (always true here) and a filesystem with links
 *   (APFS, HFS+, NTFS, ext4; not exFAT or FAT32, and not every network share).
 *   Where links are not possible the shot is referenced instead, and says so.
 * - Reference: a small file in the VFX folder naming where the media is.
 * - Physical copy: a separate copy, read back and checked against the
 *   checksum the card was ingested with, for a deliverable that must stand
 *   alone. Runs in the transfer worker, like an ingest.
 */

export interface MirrorFile extends SourceFile {
  /** The card's checksum, from ingest. */
  hash: string | null;
}

export interface MirrorPlan {
  /** The shot's key in the database. */
  key: string;
  scene: string;
  setup: string;
  take: string;
  clip: string;
  method: MirrorMethod;
  checksum: ChecksumMethod;
  production: { name: string; code: string };
  day: { number: number; date: string };
  /** The destination holding the verified editorial copy. */
  location: { legId: string; name: string; root: string; cardDir: string; files: MirrorFile[] };
}

export interface MirrorOutcome {
  legId: string;
  destination: string;
  targetDir: string;
  /** The method actually used: a hard link the drive cannot make becomes a reference. */
  method: MirrorMethod;
  state: 'mirrored' | 'failed';
  error: string | null;
}

export type RunCopy = (plan: WorkerPlan) => Promise<{ result: TransferResult; reports: WrittenReports[] }>;

/** VFX/SCENE_014/SETUP_B/T04_A015C002 on a destination. */
export const mirrorFolder = (plan: Pick<MirrorPlan, 'scene' | 'setup' | 'take' | 'clip' | 'production' | 'day'>, root: string): string =>
  join(
    root,
    segment(plan.production.name || plan.production.code),
    dayFolder(plan.day),
    'VFX',
    `SCENE_${segment(plan.scene).padStart(3, '0')}`,
    `SETUP_${plan.setup === '—' ? 'NONE' : segment(plan.setup)}`,
    `T${plan.take}_${segment(plan.clip)}`,
  );

const codeOf = (cause: unknown) => (cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : '');
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
/** What a filesystem says when it cannot make hard links. */
const NO_LINKS = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK']);

const parts = (path: string) => path.split('/');

const writeReference = async (plan: MirrorPlan, target: string, note: string | null) => {
  const { location } = plan;
  const editorial = relative(target, location.cardDir).replace(/\\/g, '/');
  const body = {
    schema: 'vcdit.vfx-reference/1',
    clip: plan.clip,
    scene: plan.scene,
    setup: plan.setup,
    take: plan.take,
    note,
    editorialFolder: editorial,
    checksumMethod: plan.checksum,
    files: location.files.map((file) => ({ path: file.path, size: file.size, checksum: file.hash })),
  };
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'VFX_REFERENCE.json'), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await writeFile(
    join(target, 'VFX_REFERENCE.txt'),
    [
      `VFX shot ${plan.clip} — Scene ${plan.scene}, Setup ${plan.setup}, Take ${plan.take}`,
      '',
      'The media is not copied here. It is in the editorial folder:',
      `  ${editorial}`,
      ...(note ? ['', note] : []),
      '',
      `Files (${plan.checksum}):`,
      ...location.files.map((file) => `  ${file.path}  ${file.size} bytes  ${file.hash ?? '—'}`),
      '',
    ].join('\n'),
    'utf8',
  );
};

/**
 * Hard-link each of a clip's files from its card folder into `target`, at
 * the same card-relative path, or say the drive cannot. A file already there
 * must be the same data (same inode); anything else is never replaced.
 */
export const linkFiles = async (cardDir: string, files: { path: string }[], target: string, where: string): Promise<'linked' | 'unsupported'> => {
  for (const file of files) {
    const source = join(cardDir, ...parts(file.path));
    const mirror = join(target, ...parts(file.path));
    const original = await stat(source);
    try {
      const existing = await stat(mirror);
      if (existing.dev === original.dev && existing.ino === original.ino) continue;
      throw new Error(`A different file is already in the ${where}: ${file.path}. It was not replaced.`);
    } catch (cause) {
      if (codeOf(cause) !== 'ENOENT') throw cause;
    }
    await mkdir(dirname(mirror), { recursive: true });
    try {
      await link(source, mirror);
    } catch (cause) {
      if (NO_LINKS.has(codeOf(cause))) return 'unsupported';
      throw cause;
    }
  }
  return 'linked';
};

const linkAll = (plan: MirrorPlan, target: string) => linkFiles(plan.location.cardDir, plan.location.files, target, 'VFX folder');

export const mirrorShot = async (plan: MirrorPlan, runCopy: RunCopy, tool: { name: string; version: string }): Promise<MirrorOutcome> => {
  const { location } = plan;
  const target = mirrorFolder(plan, location.root);
  const outcome = (method: MirrorMethod, error: string | null = null): MirrorOutcome => ({
    legId: location.legId,
    destination: location.name,
    targetDir: target,
    method,
    state: error ? 'failed' : 'mirrored',
    error,
  });
  try {
    // The destination itself must still be there, and so must its editorial copy.
    await stat(location.root);
    await stat(location.cardDir);
  } catch {
    return outcome(plan.method, `${location.name} is not available, or its copy of the clip has gone.`);
  }

  try {
    if (plan.method === 'Reference') {
      await writeReference(plan, target, null);
      return outcome('Reference');
    }
    if (plan.method === 'Hard link') {
      if ((await linkAll(plan, target)) === 'linked') return outcome('Hard link');
      await writeReference(plan, target, `${location.name} cannot hold hard links (exFAT, FAT32 or a network share), so this shot is referenced instead.`);
      return outcome('Reference');
    }

    // A physical copy: the transfer engine, from the editorial copy to the VFX folder, read back and checked.
    const leg: LegPlan = { id: location.legId, name: location.name, root: location.root, targetDir: target };
    const context: ReportContext = {
      card: `VFX_${plan.clip}`,
      tool,
      reportsDir: join(location.root, segment(plan.production.name || plan.production.code), dayFolder(plan.day), 'REPORTS', 'vfx_mirror'),
    };
    const { result } = await runCopy({
      sourceRoot: location.cardDir,
      files: location.files.map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs })),
      legs: [leg],
      allLegs: [leg],
      method: plan.checksum,
      contexts: { [leg.id]: context },
    });
    const failed = result.files.find((file) => file.legs[leg.id]?.state === 'failed');
    if (failed) return outcome('Physical copy', `${failed.path}: ${failed.legs[leg.id]!.error ?? 'did not verify'}`);
    // The editorial copy read for this must still be what came off the card.
    const drifted = result.files.find((file) => {
      const recorded = location.files.find((candidate) => candidate.path === file.path)?.hash;
      return recorded && file.sourceHash !== recorded;
    });
    if (drifted) return outcome('Physical copy', `The editorial copy of ${drifted.path} no longer matches the card's checksum. Check that destination.`);
    return outcome('Physical copy');
  } catch (cause) {
    return outcome(plan.method, message(cause));
  }
};
