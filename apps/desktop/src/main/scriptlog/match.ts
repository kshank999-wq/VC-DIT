import { clipKeyOfFile, clipKeyOfRef, loose, rollKey, soundNamesFor } from './clip-key';
import type { LogEntry } from './parse';

/**
 * Matching the log to the media (spec §4.5): each logged take to the camera
 * clips and the sound file it produced, using the strongest identifier the
 * log gives.
 *
 * - A clip name ("A015C002") that is on exactly one card today: matched.
 * - Anything weaker — a roll and a timecode, a roll alone, a clip name found
 *   on two cards, one clip claimed by two takes — is offered for review with
 *   ranked candidates, never decided silently.
 * - Nothing to go on, or a clip not ingested yet: unmatched, and tried again
 *   when the next card comes in.
 */

export interface DayClip {
  card: string;
  path: string;
  fileName: string;
  kind: 'camera' | 'sound';
  size: number;
  mtimeMs: number;
  /** The clip's timecode span in timecode seconds (frames / timebase), once its header is read. */
  tc?: { start: number; end: number } | null;
}

/** A clip as the log sees it: one camera take may be several files (RED spans, sidecars). */
export interface ClipGroup {
  key: string;
  card: string;
  kind: 'camera' | 'sound';
  files: DayClip[];
  /** When the camera finished writing it: the closest thing to its end timecode until media is read. */
  endMs: number;
  tc: { start: number; end: number } | null;
}

export interface Candidate {
  key: string;
  card: string;
  /** The clip's file time, HH:MM:SS. */
  tc: string;
  confidence: number;
  why: string;
}

export interface RefMatch {
  /** What the log said: a clip name, or "Camera A". */
  ref: string;
  camera: string;
  state: 'matched' | 'review' | 'unmatched';
  clip: { key: string; card: string } | null;
  confidence: number;
  candidates: Candidate[];
  reason: string;
}

export interface EntryMatch {
  camera: RefMatch[];
  sound: { key: string; card: string } | null;
}

const VIDEO = /\.(mxf|mov|mp4|ari|arx|r3d|braw|crm|mts|m2ts|avi|dng)$/i;
const AUDIO = /\.(wav|bwf|aif|aiff)$/i;

export const groupClips = (clips: DayClip[]): ClipGroup[] => {
  const groups = new Map<string, ClipGroup>();
  for (const clip of clips) {
    const media = clip.kind === 'sound' ? AUDIO.test(clip.fileName) : VIDEO.test(clip.fileName);
    const key = clip.kind === 'camera' ? clipKeyOfFile(clip.fileName) : null;
    // Sidecars join their clip by key; a file with no key counts only if it is media.
    if (!key && !media) continue;
    const name = key ?? clip.fileName.replace(/\.[^.]+$/, '');
    const id = `${clip.kind}|${clip.card}|${name}`;
    const group = groups.get(id) ?? { key: name, card: clip.card, kind: clip.kind, files: [], endMs: 0, tc: null };
    group.files.push(clip);
    if (media) group.endMs = Math.max(group.endMs, clip.mtimeMs);
    if (media && clip.tc && !group.tc) group.tc = clip.tc;
    groups.set(id, group);
  }
  return [...groups.values()].filter((group) => group.files.some((file) => (group.kind === 'sound' ? AUDIO : VIDEO).test(file.fileName)));
};

const secondsOfDay = (ms: number) => {
  const date = new Date(ms);
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
};
const clock = (ms: number) => (ms ? new Date(ms).toTimeString().slice(0, 8) : '—');
const tcSeconds = (tc: string): number | null => {
  const found = /^(\d{2}):(\d{2}):(\d{2})(?::(\d{2,3}))?/.exec(tc);
  return found ? Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3]) + Number(found[4] ?? 0) / 100 : null;
};

/** How sure a logged timecode inside a clip's own timecode makes a match. */
export const INSIDE_TC = 95;
const candidate = (group: ClipGroup, confidence: number, why: string): Candidate => ({
  key: group.key,
  card: group.card,
  tc: clock(group.endMs),
  confidence: Math.round(confidence),
  why,
});

/** Clips whose file time is near the logged timecode: weak evidence, ranked, capped below "matched". */
const byTime = (pool: ClipGroup[], entry: LogEntry): Candidate[] => {
  const end = tcSeconds(entry.tcOut);
  const start = tcSeconds(entry.tcIn);
  const target = end ?? start;
  if (target === null) return [];
  // Clips whose timecode has been read: the logged start inside the clip's span is near-certain.
  const coded = pool.filter((group) => group.tc);
  if (coded.length && start !== null) {
    const inside = coded.filter((group) => start >= group.tc!.start - 1 && start <= group.tc!.end + 1);
    const nearest = coded
      .filter((group) => !inside.includes(group))
      .map((group) => ({ group, gap: Math.round(Math.min(Math.abs(group.tc!.start - start), Math.abs(group.tc!.end - start))) }))
      .filter((item) => item.gap < 600)
      .sort((a, b) => a.gap - b.gap)
      .slice(0, 3);
    return [
      ...inside.map((group) => candidate(group, inside.length === 1 ? INSIDE_TC : 70, "Logged TC is inside this clip's timecode")),
      ...nearest.map(({ group, gap }) => candidate(group, Math.max(10, 50 - gap / 6), `Clip timecode ${gap < 60 ? `${gap}s` : `${Math.round(gap / 60)} min`} from the logged TC`)),
    ];
  }
  return pool
    .map((group) => {
      const gap = Math.round(Math.abs(secondsOfDay(group.endMs) - target));
      // A clip's file time is when it stopped recording: after the logged start, close to the logged end.
      const closeness = Math.max(0, 1 - gap / (end !== null ? 300 : 900));
      return { group, gap, closeness };
    })
    .filter((item) => item.closeness > 0)
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 4)
    .map(({ group, gap, closeness }) =>
      candidate(
        group,
        30 + 50 * closeness,
        `File time ${gap < 60 ? `${gap}s` : `${Math.round(gap / 60)} min`} from the logged ${end !== null ? 'end' : 'start'} TC`,
      ),
    );
};

const matchRef = (entry: LogEntry, ref: string, camera: string, cameras: ClipGroup[]): RefMatch => {
  const key = clipKeyOfRef(ref);
  const exact = cameras.filter((group) => (key ? group.key === key : loose(group.key) === loose(ref)));
  const base = { ref, camera: camera || key?.[0] || '' };
  if (exact.length === 1) {
    return { ...base, state: 'matched', clip: { key: exact[0]!.key, card: exact[0]!.card }, confidence: 100, candidates: [], reason: '' };
  }
  if (exact.length > 1) {
    return {
      ...base,
      state: 'review',
      clip: null,
      confidence: 0,
      candidates: exact.map((group) => candidate(group, 60, `Clip name matches, on card ${group.card}`)),
      reason: `${key ?? ref} is on ${exact.length} cards today. Pick the one this take is on.`,
    };
  }
  // Not here: maybe a card not ingested yet, maybe a typo. Offer the same roll's clips, nearest first.
  const roll = key?.slice(0, 4) ?? rollKey(entry.roll);
  const sameRoll = roll ? cameras.filter((group) => group.key.startsWith(roll)) : [];
  const timed = byTime(sameRoll.length ? sameRoll : cameras.filter((group) => !camera || group.key.startsWith(camera)), entry);
  const number = key ? Number(key.slice(5)) : NaN;
  const nearby = timed.length
    ? timed
    : sameRoll
        .map((group) => ({ group, distance: Math.abs(Number(group.key.slice(5)) - number) }))
        .filter((item) => Number.isFinite(item.distance))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 3)
        .map(({ group, distance }) =>
          candidate(group, Math.max(15, 45 - distance * 10), `Same roll, clip ${distance === 1 ? 'next to' : `${distance} away from`} the logged one`),
        );
  if (nearby.length === 0) {
    return {
      ...base,
      state: 'unmatched',
      clip: null,
      confidence: 0,
      candidates: [],
      reason: roll && !sameRoll.length ? `No card ${roll} has been ingested today yet.` : `${ref} is not on any card ingested today.`,
    };
  }
  return { ...base, state: 'review', clip: null, confidence: 0, candidates: nearby, reason: `Logged clip ${ref} is not on the cards; these are the closest.` };
};

const matchWithoutName = (entry: LogEntry, camera: string, cameras: ClipGroup[]): RefMatch => {
  const roll = rollKey(entry.roll);
  const pool = cameras.filter(
    (group) => (!roll || group.key.startsWith(roll) || group.card.toUpperCase() === entry.roll.toUpperCase()) && (!camera || group.key.startsWith(camera)),
  );
  const base = { ref: camera ? `Camera ${camera}` : roll ? `Roll ${roll}` : 'Camera', camera };
  if (!roll && !entry.tcIn && !entry.tcOut) {
    return { ...base, state: 'unmatched', clip: null, confidence: 0, candidates: [], reason: 'The log gives no clip name, roll or timecode for this take.' };
  }
  const timed = byTime(pool, entry);
  const candidates = timed.length ? timed : roll ? pool.slice(0, 6).map((group) => candidate(group, 25, `On roll ${roll}`)) : [];
  if (candidates.length === 0) {
    return {
      ...base,
      state: 'unmatched',
      clip: null,
      confidence: 0,
      candidates: [],
      reason: roll ? `No clips from roll ${roll} ingested today yet.` : 'No clip near the logged timecode.',
    };
  }
  // The logged timecode inside exactly one clip's own timecode: matched.
  const sure = candidates.filter((item) => item.confidence >= INSIDE_TC);
  if (sure.length === 1) {
    return { ...base, state: 'matched', clip: { key: sure[0]!.key, card: sure[0]!.card }, confidence: INSIDE_TC, candidates: [], reason: '' };
  }
  return {
    ...base,
    state: 'review',
    clip: null,
    confidence: 0,
    candidates,
    reason: 'No clip name in the log: matched by roll and time only. Confirm the right one.',
  };
};

const matchSound = (entry: LogEntry, sounds: ClipGroup[]): { key: string; card: string } | null => {
  const wanted = entry.soundRef ? [loose(entry.soundRef)] : soundNamesFor(entry.scene, entry.setup, entry.take);
  const found = sounds.filter((group) => wanted.includes(loose(group.key)));
  return found.length === 1 ? { key: found[0]!.key, card: found[0]!.card } : null;
};

/** Match every entry of the day. Entries are matched independently, then a clip claimed twice goes to review. */
export const matchDay = <T extends LogEntry>(entries: T[], clips: DayClip[]): Map<T, EntryMatch> => {
  const groups = groupClips(clips);
  const cameras = groups.filter((group) => group.kind === 'camera');
  const sounds = groups.filter((group) => group.kind === 'sound');
  const out = new Map<T, EntryMatch>();
  for (const entry of entries) {
    const refs: RefMatch[] = entry.clipRefs.length
      ? entry.clipRefs.map((ref, index) => matchRef(entry, ref, entry.cameras[index] ?? '', cameras))
      : (entry.cameras.length ? entry.cameras : ['']).map((camera) => matchWithoutName(entry, camera, cameras));
    out.set(entry, { camera: refs, sound: matchSound(entry, sounds) });
  }

  // One clip, two takes: the log has a mistake somewhere. Both go to review.
  const claims = new Map<string, { entry: T; ref: RefMatch }[]>();
  for (const [entry, match] of out) {
    for (const ref of match.camera) {
      if (ref.state !== 'matched' || !ref.clip) continue;
      const id = `${ref.clip.card}|${ref.clip.key}`;
      claims.set(id, [...(claims.get(id) ?? []), { entry, ref }]);
    }
  }
  for (const claimants of claims.values()) {
    if (claimants.length < 2) continue;
    for (const { entry, ref } of claimants) {
      const others = claimants.filter((other) => other.entry !== entry).map((other) => `Sc ${other.entry.scene}${other.entry.setup} T${other.entry.take}`);
      const clip = ref.clip!;
      Object.assign(ref, {
        state: 'review',
        clip: null,
        confidence: 0,
        candidates: [{ key: clip.key, card: clip.card, tc: '—', confidence: 50, why: 'Clip name matches' }],
        reason: `${clip.key} is also logged as ${others.join(', ')}. Check which take it is.`,
      });
    }
  }
  return out;
};
