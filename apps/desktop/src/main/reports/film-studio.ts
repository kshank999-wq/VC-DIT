import type { ChecksumMethod } from '../../shared/media';
import type { ReportEntry } from '../../shared/project';
import type { ProductionDb, TransferRecord } from '../db/production-db';
import { isPictureFile, pictureKey, sequenceOf } from '../scriptlog/clip-key';

/**
 * The day's DIT log for VC Film Studio's DIT section (its "Media/data
 * tracking"): VC DIT is its companion on the cart. One JSON file per shoot
 * day in the shape Film Studio keeps:
 *
 * - each card as a **roll** (label, camera or sound, clips, bytes) with its
 *   **copies** (destination, checksum method, verified when, files, bytes, and
 *   what did not match), as in Film Studio's media_roll / media_copy. A copy
 *   is only "verified" when every file on it verified. A card VC DIT erased
 *   for reuse carries `clearedAt`: when, after its own re-check of the
 *   copies (media-service clearCard), so Film Studio's data desk records the
 *   wipe and can hold it to the production's copy rule. Each roll lists its
 *   picture clips in `clipFiles`: the clip's key as the takes name it
 *   (A015C002), the file as it was copied, and, when VC DIT renamed it on
 *   offload, the name it had on the card — so an editor's ALE or XML points
 *   at files that exist;
 * - the DIT's **notes**, each with its timecode and where that came from, and
 *   the shot it is about (or general);
 * - the takes, sync, dailies, VFX shots and deliveries, and the day's reports.
 *   A daily published to the production's Frame.io carries `frameio`: whether
 *   it went up and the link to watch it, so Film Studio can show it beside the
 *   daily. Added fields only: a Film Studio that does not know them ignores
 *   them, so the schema stays dit-day/1.
 *
 * Film Studio matches the day by its date and the production by its code.
 */

export const FILM_STUDIO_SCHEMA = 'vc-film-studio.dit-day/1';

const METHOD: Record<ChecksumMethod, 'xxhash64' | 'md5' | 'sha1'> = { xxHash64: 'xxhash64', MD5: 'md5', 'SHA-1': 'sha1' };

/** Film Studio's destination kinds, from the drive's name: shuttles and archives say so; the first copy is the primary. */
export const destinationKind = (name: string, index: number): 'primary' | 'backup' | 'shuttle' | 'archive' | 'cloud' =>
  /shuttle|shtl/i.test(name) ? 'shuttle' : /archive|lto|nas/i.test(name) ? 'archive' : index === 0 ? 'primary' : 'backup';

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * A roll's picture clips, one entry per clip: sidecars (.xml, .thm) are not
 * clips, and the frames of an image sequence are one clip, named by its first
 * frame and counted. `path` is where the clip is under the card's folder on
 * every copy; `original` is the card's own name for it, only when VC DIT
 * renamed it on offload (renameForCard), else null.
 */
export const clipFilesOf = (files: TransferRecord['files']) => {
  const clips = new Map<string, { clip: string; file: string; path: string; original: string | null; frames: number | null }>();
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const name = baseName(file.path);
    if (!isPictureFile(name)) continue;
    const sequence = sequenceOf(name);
    const folder = file.path.slice(0, file.path.length - name.length);
    const id = sequence ? `${folder}${sequence.stem}` : file.path;
    const known = clips.get(id);
    if (known) {
      if (known.frames !== null) known.frames += 1;
      continue;
    }
    clips.set(id, {
      clip: pictureKey(name),
      file: name,
      path: file.path,
      original: file.source && baseName(file.source) !== name ? baseName(file.source) : null,
      frames: sequence ? 1 : null,
    });
  }
  return [...clips.values()];
};

export const filmStudioDay = (db: ProductionDb, day: number, reports: ReportEntry[], tool: { name: string; version: string }, now = new Date()) => {
  const production = db.production();
  const shootDay = db.days().find((candidate) => candidate.number === day) ?? db.currentDay();
  const view = db.logView(day);
  const rolls = db.transfers(day).map((transfer) => {
    const bytes = transfer.files.reduce((sum, file) => sum + file.size, 0);
    return {
      label: transfer.card,
      kind: transfer.sound ? ('sound' as const) : ('camera' as const),
      cameraDesignation: transfer.sound ? null : (/^([A-Z])\d/i.exec(transfer.card)?.[1]?.toUpperCase() ?? null),
      recordedOn: shootDay.date,
      clips: transfer.files.length,
      bytes,
      /* When the card was erased for reuse, or null while it still holds the footage. */
      clearedAt: transfer.clearedAt ?? null,
      /* The picture clips by name: what the takes call them, what was copied, and what the card called them. */
      clipFiles: clipFilesOf(transfer.files),
      copies: transfer.destinations.map((leg, index) => {
        const outcomes = Object.values(leg.outcomes);
        const failed = outcomes.filter((outcome) => outcome.state === 'failed').length;
        const verified = Boolean(transfer.finishedAt) && !leg.error && failed === 0 && outcomes.length === transfer.files.length;
        return {
          destinationKind: destinationKind(leg.name, index),
          destinationLabel: leg.name,
          checksumMethod: METHOD[transfer.checksum],
          copiedAt: transfer.finishedAt ?? transfer.startedAt,
          verifiedAt: verified ? transfer.finishedAt : null,
          files: outcomes.length - failed,
          bytes,
          mismatchNote: leg.error ?? (failed ? `${failed} file${failed === 1 ? '' : 's'} did not verify` : null),
        };
      }),
    };
  });
  return {
    schema: FILM_STUDIO_SCHEMA,
    createdAt: now.toISOString(),
    tool,
    production: { name: production.name, code: production.code, frameRate: production.frameRate },
    shootDay: { number: shootDay.number, date: shootDay.date, locations: shootDay.locations, dit: shootDay.operator },
    rolls,
    notes: db.notes(day).map((note) => ({
      timecode: note.tc,
      timecodeSource: note.tcSource,
      rate: note.rate,
      loggedAt: note.at,
      scope: note.scope,
      scene: note.scene || null,
      setup: note.setup || null,
      take: note.take || null,
      clip: note.clip || null,
      text: note.text,
      during: note.screen || null,
    })),
    takes: view.scenes.flatMap((scene) =>
      scene.setups.flatMap((setup) =>
        setup.takes.map((take) => ({
          scene: scene.id,
          setup: setup.id,
          take: take.take.replace(/^T/, ''),
          clips: [take.clipA, take.clipB].filter((clip): clip is string => Boolean(clip) && clip !== '—'),
          sound: take.sound === '—' ? null : take.sound,
          timecode: take.tc || null,
          circle: take.circle,
          vfx: take.vfx,
          match: take.match,
        })),
      ),
    ),
    sync: db.syncView(day).map((item) => ({ clip: item.clip, take: item.take, sound: item.sound === '—' ? null : item.sound, method: item.method, offsetFrames: item.offsetFrames, accepted: item.accepted })),
    dailies: db.renders(day).map((render) => ({
      take: render.label, clip: render.clip, look: render.lut, codec: render.codec, bytes: render.bytes, result: render.state, error: render.error,
      /* Only this render, in the project published to now (production-db publishedAs); null when not published. */
      frameio: render.frameio ? { state: render.frameio.state, viewUrl: render.frameio.viewUrl, error: render.frameio.error } : null,
    })),
    vfx: view.vfx.map((shot) => ({ scene: shot.scene, setup: shot.setup, take: shot.take, clip: shot.clip, note: shot.note, flaggedBy: shot.flaggedBy, sentToVfxPrep: shot.sentAt })),
    deliveries: db.deliveries(day).map((record) => ({
      package: record.packageName,
      destination: record.destination,
      files: record.files,
      bytes: record.bytes,
      verified: record.verified + record.alreadyThere,
      failed: record.failed,
      retries: record.retries,
      finishedAt: record.finishedAt,
    })),
    reports: reports.map(({ name, covers, word, status, time }) => ({ name, covers, status, word, time })),
  };
};
