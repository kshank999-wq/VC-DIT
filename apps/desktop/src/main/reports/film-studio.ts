import type { ChecksumMethod } from '../../shared/media';
import type { ReportEntry } from '../../shared/project';
import type { ProductionDb } from '../db/production-db';

/**
 * The day's DIT log for VC Film Studio's DIT section (its "Media/data
 * tracking"): VC DIT is its companion on the cart. One JSON file per shoot
 * day in the shape Film Studio keeps:
 *
 * - each card as a **roll** (label, camera or sound, clips, bytes) with its
 *   **copies** (destination, checksum method, verified when, files, bytes, and
 *   what did not match), as in Film Studio's media_roll / media_copy. A copy
 *   is only "verified" when every file on it verified;
 * - the DIT's **notes**, each with its timecode and where that came from, and
 *   the shot it is about (or general);
 * - the takes, sync, dailies, VFX shots and deliveries, and the day's reports.
 *
 * Film Studio matches the day by its date and the production by its code.
 */

export const FILM_STUDIO_SCHEMA = 'vc-film-studio.dit-day/1';

const METHOD: Record<ChecksumMethod, 'xxhash64' | 'md5' | 'sha1'> = { xxHash64: 'xxhash64', MD5: 'md5', 'SHA-1': 'sha1' };

/** Film Studio's destination kinds, from the drive's name: shuttles and archives say so; the first copy is the primary. */
export const destinationKind = (name: string, index: number): 'primary' | 'backup' | 'shuttle' | 'archive' | 'cloud' =>
  /shuttle|shtl/i.test(name) ? 'shuttle' : /archive|lto|nas/i.test(name) ? 'archive' : index === 0 ? 'primary' : 'backup';

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
    dailies: db.renders(day).map((render) => ({ take: render.label, clip: render.clip, look: render.lut, codec: render.codec, bytes: render.bytes, result: render.state, error: render.error })),
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
