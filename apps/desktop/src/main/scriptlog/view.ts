import type { LogSummary, MatchEntry, SceneEntry, SetupEntry, TakeEntry } from '../../shared/project';
import type { Candidate } from './match';
import type { LogEntry } from './parse';

/**
 * The day's log as the screens show it: the scene list with its setups and
 * takes, the entries waiting on the DIT (Match review), the VFX flags, and
 * the import's numbers. Built from what the database keeps; no matching
 * happens here.
 */

export interface StoredEntry extends LogEntry {
  id: number;
}

export interface StoredMatch {
  entryId: number;
  refIndex: number;
  ref: string;
  camera: string;
  state: 'matched' | 'review' | 'unmatched';
  clipKey: string | null;
  clipCard: string | null;
  candidates: Candidate[];
  reason: string;
  /** Who decided: the matcher, the DIT picking a clip, or the DIT saying there is none. */
  decided: 'auto' | 'dit' | 'wild';
}

/** A VFX-flagged take's clip, from the log: one per camera clip of the take. */
export interface VfxFlag {
  scene: string;
  setup: string;
  /** Two digits: "04". */
  take: string;
  clip: string;
  /** The card the clip is on, once matched. */
  card: string | null;
  note: string;
  matched: boolean;
}

export interface StoredImport {
  fileName: string;
  format: string;
  importedAt: string;
  warnings: string[];
}

/** How a candidate is named on screen: its clip key, with the card when two candidates share a key. */
export const candidateLabel = (candidate: Candidate, all: Candidate[]): string =>
  all.filter((other) => other.key === candidate.key).length > 1 ? `${candidate.key} · ${candidate.card}` : candidate.key;

const pad2 = (take: string) => take.padStart(2, '0');

const frames = (tc: string, base: number): number | null => {
  const found = /^(\d{2}):(\d{2}):(\d{2}):(\d{2,3})$/.exec(tc);
  if (!found) return null;
  return ((Number(found[1]) * 60 + Number(found[2])) * 60 + Number(found[3])) * base + Number(found[4]);
};

const duration = (tcIn: string, tcOut: string, fps: number): string => {
  const base = Math.round(fps) || 24;
  const start = frames(tcIn, base);
  const end = frames(tcOut, base);
  if (start === null || end === null || end <= start) return '—';
  const seconds = Math.round((end - start) / base);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** An entry's standing: every clip known (or declared absent), something to confirm, or nothing found. */
const standing = (matches: StoredMatch[]): TakeEntry['match'] => {
  if (matches.some((match) => match.decided === 'auto' && match.state === 'unmatched')) return 'Unmatched';
  if (matches.some((match) => match.decided === 'auto' && match.state === 'review')) return 'Review';
  return 'Matched';
};

export const buildLogView = (input: {
  scenes: SceneEntry[];
  entries: StoredEntry[];
  matches: StoredMatch[];
  sounds: Map<number, string>;
  log: StoredImport | null;
  frameRate: string;
}): { scenes: (SceneEntry & { setups: SetupEntry[] })[]; log: LogSummary | null; matches: MatchEntry[]; vfx: VfxFlag[] } => {
  const fps = Number.parseFloat(input.frameRate) || 24;
  const byEntry = new Map<number, StoredMatch[]>();
  for (const match of input.matches)
    byEntry.set(
      match.entryId,
      [...(byEntry.get(match.entryId) ?? []), match].sort((a, b) => a.refIndex - b.refIndex),
    );
  const matchesOf = (entry: StoredEntry) => byEntry.get(entry.id) ?? [];
  const clipOf = (match: StoredMatch) => (match.decided !== 'wild' && match.state === 'matched' && match.clipKey ? match.clipKey : null);

  // ------------------------------------------------ scenes → setups → takes
  const takes = new Map<string, StoredEntry[]>();
  for (const entry of input.entries) {
    const id = `${entry.scene}|${entry.setup || '—'}|${entry.take}`;
    takes.set(id, [...(takes.get(id) ?? []), entry]);
  }
  const setups = new Map<string, Map<string, SetupEntry>>();
  for (const [id, group] of takes) {
    const [scene, setupId] = id.split('|') as [string, string];
    const first = group[0]!;
    const all = group.flatMap(matchesOf);
    const clips = all
      .filter((match) => clipOf(match))
      .sort((a, b) => (a.camera || a.clipKey![0]!).localeCompare(b.camera || b.clipKey![0]!))
      .map((match) => match.clipKey!);
    const take: TakeEntry = {
      id,
      take: `T${pad2(first.take)}`,
      clipA: clips[0] ?? '—',
      clipB: clips[1] ?? null,
      sound: group.map((entry) => input.sounds.get(entry.id)).find(Boolean) ?? group.find((entry) => entry.soundRef)?.soundRef ?? '—',
      tc: group.find((entry) => entry.tcIn)?.tcIn ?? '—',
      duration: duration(group.find((entry) => entry.tcIn)?.tcIn ?? '', group.find((entry) => entry.tcOut)?.tcOut ?? '', fps),
      circle: group.some((entry) => entry.circle || entry.print),
      vfx: group.some((entry) => entry.vfx),
      match: standing(all),
      sync: 'pending',
    };
    const sceneSetups = setups.get(scene) ?? new Map<string, SetupEntry>();
    const setup = sceneSetups.get(setupId) ?? { id: setupId, lens: '', takes: [] };
    setup.lens ||= group.find((entry) => entry.lens)?.lens ?? '';
    setup.takes.push(take);
    sceneSetups.set(setupId, setup);
    setups.set(scene, sceneSetups);
  }
  const scenes = input.scenes.map((scene) => ({
    ...scene,
    setups: [...(setups.get(scene.id)?.values() ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map((setup) => ({ ...setup, takes: setup.takes.sort((a, b) => a.take.localeCompare(b.take, undefined, { numeric: true })) })),
  }));

  // ------------------------------------------------ what the DIT decides
  const entryById = new Map(input.entries.map((entry) => [entry.id, entry]));
  const review: MatchEntry[] = input.matches
    .filter((match) => match.state !== 'matched' || match.decided !== 'auto')
    .map((match) => {
      const entry = entryById.get(match.entryId)!;
      const labels = match.candidates.map((candidate) => candidateLabel(candidate, match.candidates));
      const decidedLabel =
        match.decided === 'dit'
          ? labels[match.candidates.findIndex((candidate) => candidate.key === match.clipKey && candidate.card === match.clipCard)]
          : undefined;
      const fields: [string, string][] = [
        ['Scene', entry.scene],
        ['Setup', entry.setup || '—'],
        ['Take', `${entry.take}${entry.circle ? ' ◎' : ''}`],
        ['Camera', match.camera || '—'],
      ];
      if (entry.clipRefs[match.refIndex]) fields.push(['Log clip', entry.clipRefs[match.refIndex]!]);
      if (entry.roll) fields.push(['Log roll', entry.roll]);
      if (entry.tcIn) fields.push(['Log TC', entry.tcIn]);
      if (entry.notes || entry.vfxNote) fields.push(['Note', entry.notes || `VFX — ${entry.vfxNote}`]);
      return {
        id: `${match.entryId}:${match.refIndex}`,
        log: `Sc ${entry.scene} / ${entry.setup || '—'} / T${pad2(entry.take)}${match.camera ? ` · ${match.camera} cam` : ''}`,
        reason: match.reason,
        fields,
        candidates: match.candidates.map((candidate, index) => ({
          clip: labels[index]!,
          tc: candidate.tc,
          confidence: candidate.confidence,
          why: candidate.why,
        })),
        picked: Math.max(0, decidedLabel ? labels.indexOf(decidedLabel) : 0),
        resolution: match.decided === 'wild' ? { kind: 'wild' } : decidedLabel ? { kind: 'matched', clip: decidedLabel } : null,
      };
    });

  // ------------------------------------------------ VFX flags
  const flagged = input.entries.filter((entry) => entry.vfx);
  // Every camera clip of a VFX take is a plate; a clip not yet known shows as what the log called it.
  const vfx: VfxFlag[] = flagged.flatMap((entry) => {
    const base = { scene: entry.scene, setup: entry.setup || '—', take: pad2(entry.take), note: entry.vfxNote || entry.notes };
    const matches = matchesOf(entry).filter((match) => match.decided !== 'wild');
    if (matches.length === 0) return [{ ...base, clip: entry.clipRefs[0] ?? '—', card: null, matched: false }];
    return matches.map((match) => {
      const clip = clipOf(match);
      return clip ? { ...base, clip, card: match.clipCard, matched: true } : { ...base, clip: match.ref || '—', card: null, matched: false };
    });
  });

  // ------------------------------------------------ the import's numbers
  const standings = input.entries.map((entry) => standing(matchesOf(entry)));
  const log: LogSummary | null = input.log
    ? {
        file: input.log.fileName,
        format: input.log.format,
        importedAt: new Date(input.log.importedAt).toTimeString().slice(0, 5),
        entries: input.entries.length,
        vfxFlags: flagged.length,
        matched: standings.filter((value) => value === 'Matched').length,
        review: standings.filter((value) => value === 'Review').length,
        unmatched: standings.filter((value) => value === 'Unmatched').length,
        warnings: input.log.warnings,
      }
    : null;

  return { scenes, log, matches: review, vfx };
};
