import type { LogEntry, ParsedLog } from './parse';

/**
 * VC Smart Slate's day (`vc-smart-slate.manifest/1`), read as a script log
 * without losing what only the slate knows.
 *
 * The generic JSON path would find the manifest's `dit_log` rows and read
 * them, but it would drop three things that matter here:
 *
 * - **Drop frame.** "14:00:00;10" is a 29.97 DF label; read as
 *   "14:00:00:10" it is a different frame by the hour's end.
 * - **The rate**, held as a rational (30000/1001), never as 29.97.
 * - **Every clap.** A take can have several (a second sticks, a tail), each
 *   with its own timecode, lock state and review flags, and a manual
 *   correction never replaces the clap it corrects: both are kept, with the
 *   reason.
 *
 * One entry per take per camera, as the slate writes `dit_log`. The slate
 * does not know clip names, so matching runs on roll and timecode, which is
 * exactly what the matcher offers for review rather than deciding.
 */

export const SLATE_SCHEMA = 'vc-smart-slate.manifest';
const SUPPORTED_VERSION = 1;

export interface SlateRate {
  numerator: number;
  denominator: number;
  dropFrame: boolean;
  /** "29.97 DF", as the slate shows it. */
  label: string;
}

export interface SlateClap {
  id: string;
  /** slate, tail, second_sticks or marker. */
  kind: string;
  ordinal: number;
  sequence: number;
  /** As the slate captured it, with `;` for drop frame; empty when it had none. */
  timecode: string;
  frameCount: number | null;
  lockState: string;
  syncState: string;
  reviewFlags: string[];
  capturedUtc: string;
  /** A manual timecode entered afterwards; the captured one above is never changed. */
  correction: { timecode: string; reason: string; by: string; at: string } | null;
}

export interface SlateTake {
  takeId: string;
  rate: SlateRate | null;
  /** The take's timecode source: the box, the device clock, or manual. */
  source: string;
  syncState: string;
  manual: boolean;
  epoch: number | null;
  runningTimeMs: number | null;
  sequentialSlate: number | null;
  tags: string[];
  claps: SlateClap[];
}

type Json = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter((item): item is Json => !!item && typeof item === 'object') : []);

/** Whether parsed JSON is the slate's manifest (any version). */
export const isSlateManifest = (data: unknown): data is Json =>
  !!data && typeof data === 'object' && text((data as Json)['schema']).startsWith(`${SLATE_SCHEMA}/`);

export const parseSlateManifest = (data: Json): ParsedLog => {
  const version = num(data['schema_version']) ?? Number(text(data['schema']).split('/')[1]);
  if (!(version >= 1)) throw new Error('This VC Smart Slate file has no schema version.');
  if (version > SUPPORTED_VERSION) {
    throw new Error(`This day was written by a newer VC Smart Slate (format ${version}). Update VC DIT to import it.`);
  }
  const detail = (data['detail'] ?? {}) as Json;
  const corrections = new Map(list(detail['corrections']).map((c) => [text(c['clap_id']), c]));
  const clapsByTake = new Map<string, SlateClap[]>();
  for (const clap of list(detail['claps'])) {
    const tc = (clap['timecode'] ?? null) as Json | null;
    const fix = corrections.get(text(clap['id']));
    const fixed = (fix?.['snapshot'] ?? null) as Json | null;
    const entry: SlateClap = {
      id: text(clap['id']),
      kind: text(clap['type']) || 'slate',
      ordinal: num(clap['ordinal']) ?? 1,
      sequence: num(clap['sequence']) ?? 0,
      timecode: tc ? text(tc['formatted']) : '',
      frameCount: tc ? num(tc['frame_count']) : null,
      lockState: tc ? text(tc['lock_state']) : 'none',
      syncState: text(clap['sync_state']),
      reviewFlags: Array.isArray(clap['review_flags']) ? (clap['review_flags'] as unknown[]).map(text) : [],
      capturedUtc: text(clap['captured_utc']),
      correction: fix
        ? { timecode: fixed ? text(fixed['formatted']) : '', reason: text(fix['reason']), by: text(fix['actor_id']), at: text(fix['at']) }
        : null,
    };
    const take = text(clap['take_id']);
    clapsByTake.set(take, [...(clapsByTake.get(take) ?? []), entry]);
  }

  const warnings: string[] = [];
  const entries: LogEntry[] = list(data['dit_log']).flatMap((row, index) => {
    const scene = text(row['scene']).trim().toUpperCase();
    const take = text(row['take']).replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    if (!scene || !take) {
      warnings.push(`Row ${index + 1}: no ${!scene ? 'scene' : 'take number'} — skipped.`);
      return [];
    }
    const setup = text(row['setup']).trim().toUpperCase();
    const camera = text(row['camera']).trim().toUpperCase();
    const numerator = num(row['tc_rate_numerator']);
    const denominator = num(row['tc_rate_denominator']);
    const notes = [text(row['notes']), text(row['camera_notes']) && `${camera}: ${text(row['camera_notes'])}`].filter(Boolean).join(' — ');
    const fromSlate: SlateTake = {
      takeId: text(row['take_id']),
      rate: numerator && denominator
        ? { numerator, denominator, dropFrame: row['drop_frame'] === true, label: text(row['tc_rate']) }
        : null,
      source: text(row['tc_source']),
      syncState: text(row['sync_state']),
      manual: row['tc_manual'] === true,
      epoch: num(row['tc_epoch']),
      runningTimeMs: num(row['running_time_ms']),
      sequentialSlate: num(row['sequential_slate']),
      tags: Array.isArray(row['tags']) ? (row['tags'] as unknown[]).map(text) : [],
      // This camera's claps: the ones that name it, or all when none do.
      claps: (clapsByTake.get(text(row['take_id'])) ?? []).filter((clap) => {
        const named = list(detail['claps']).find((c) => text(c['id']) === clap.id)?.['camera_ids'];
        return !Array.isArray(named) || named.length === 0 || (named as unknown[]).map(text).includes(camera);
      }),
    };
    return [{
      line: index + 1,
      scene,
      setup,
      take,
      slate: `${scene}${setup}`,
      cameras: camera ? [camera] : [],
      clipRefs: [],
      roll: text(row['roll']),
      soundRoll: text(row['sound_roll']),
      soundRef: '',
      // Kept exactly, `;` and all: the slate's label is the authority.
      tcIn: text(row['tc_in']),
      tcOut: '',
      circle: row['circle'] === true,
      print: false,
      vfx: false,
      vfxNote: '',
      notes,
      lens: text(row['lens']),
      description: [text(row['slugline']), text(row['shot_description'])].filter(Boolean).join(' — '),
      fromSlate,
    }];
  });
  if (entries.length === 0) throw new Error('This VC Smart Slate day has no takes.');
  return { format: 'VC Smart Slate', entries, warnings };
};

const running = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** What the review screen says about a take from the slate. */
export const slateSummary = (take: SlateTake): string => {
  const claps = take.claps.map((clap) => {
    const tc = clap.correction ? `${clap.correction.timecode} (manual, was ${clap.timecode || 'none'}: ${clap.correction.reason})` : clap.timecode || 'no timecode';
    const flags = clap.reviewFlags.length ? ` [${clap.reviewFlags.join(', ')}]` : '';
    return `${clap.kind === 'slate' ? 'clap' : clap.kind.replace('_', ' ')} ${tc}${flags}`;
  });
  return [
    take.rate?.label,
    take.syncState && take.syncState.toUpperCase(),
    take.runningTimeMs !== null ? `ran ${running(take.runningTimeMs)}` : '',
    ...claps,
  ].filter(Boolean).join(' · ');
};
