import { clipKeyOfRef, rollKey } from '../scriptlog/clip-key';

/**
 * Where each camera clip belongs, from everything that says so (spec §4.4,
 * §4.5): the script supervisor's log, the camera report, the slate the sound
 * recorder wrote into its synced file, and the DIT's own assignment.
 *
 * - The DIT's own word (an assignment, or a decision between sources) wins.
 * - Otherwise every source that names the clip must agree on the slate
 *   (scene and setup) and the take. One source alone is enough.
 * - When they disagree, nothing is guessed: the clip waits, unassigned, and
 *   the disagreement goes to Match Review for the DIT to decide.
 */

export type AssignSource = 'log' | 'report' | 'sound' | 'manual';

export interface Slate {
  scene: string;
  setup: string;
  /** Digits only: "3". */
  take: string;
  circle: boolean;
}

export interface Claim extends Slate {
  source: AssignSource;
  /** Where it came from, for the screens: "Camera report row 4", "888_D14_02.wav". */
  from: string;
}

export interface Assignment {
  card: string;
  clip: string;
  /** Where the clip goes; null while sources disagree, or nothing names it. */
  slate: Slate | null;
  /** Which source placed it ("manual" when the DIT assigned or decided). */
  by: AssignSource | null;
  claims: Claim[];
  conflict: boolean;
}

export const SOURCE_WORD: Record<AssignSource, string> = {
  log: 'Script log',
  report: 'Camera report',
  sound: 'Sound slate',
  manual: 'DIT',
};

/** Digits only, no leading zeros: "04" and "T4" are the same take. */
export const takeNumber = (take: string): string => String(Number(take.replace(/\D/g, '')) || take.trim());

/** "14", "B" and "14B" compared alike: scene and setup run together, uppercase, no spaces or dashes. */
export const slateKey = (scene: string, setup: string): string => `${scene}${setup}`.toUpperCase().replace(/[^A-Z0-9]/g, '');

const same = (a: Slate, b: Slate) => slateKey(a.scene, a.setup) === slateKey(b.scene, b.setup) && takeNumber(a.take) === takeNumber(b.take);

/**
 * A slate as a sound recorder writes it ("14B") into scene and setup. A
 * scene the day's list has under that name stays whole ("14A" when 14A is
 * a scene); otherwise the trailing letters are the setup.
 */
export const splitSlate = (slate: string, scenes: Set<string>): { scene: string; setup: string } => {
  const text = slate.toUpperCase().replace(/\s+/g, '');
  if (scenes.has(text)) return { scene: text, setup: '' };
  const parts = /^(\d+)([A-Z]*)$/.exec(text);
  if (!parts) return { scene: text, setup: '' };
  // "14AB" with scene 14A on the list: scene 14A, setup B.
  if (parts[2] && scenes.has(`${parts[1]}${parts[2][0]}`)) return { scene: `${parts[1]}${parts[2][0]}`, setup: parts[2].slice(1) };
  return { scene: parts[1]!, setup: parts[2]! };
};

export const resolveAssignment = (card: string, clip: string, claims: Claim[]): Assignment => {
  const manual = claims.find((claim) => claim.source === 'manual');
  if (manual) return { card, clip, slate: pick(manual), by: 'manual', claims, conflict: false };
  const others = claims.filter((claim) => claim.source !== 'manual');
  if (others.length === 0) return { card, clip, slate: null, by: null, claims, conflict: false };
  const first = others[0]!;
  if (!others.every((claim) => same(claim, first))) return { card, clip, slate: null, by: null, claims, conflict: true };
  // They agree. The log's own wording, then the report's, then the sound's; circled if any says so.
  const order: AssignSource[] = ['log', 'report', 'sound'];
  const best = [...others].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))[0]!;
  return { card, clip, slate: { ...pick(best), circle: others.some((claim) => claim.circle) }, by: best.source, claims, conflict: false };
};

const pick = (claim: Claim): Slate => ({ scene: claim.scene, setup: claim.setup, take: takeNumber(claim.take), circle: claim.circle });

/**
 * The clip a camera report row means on a card: a full clip name
 * ("A015C002", "A015_C002"), or just the clip ("C002", "2") on the row's card.
 */
export const reportClipKey = (card: string, ref: string): string | null => {
  const full = clipKeyOfRef(ref);
  if (full) return full;
  const roll = rollKey(card);
  const number = /^\s*C?\s*[-_ ]?\s*0*(\d{1,4})\s*$/i.exec(ref);
  return roll && number ? `${roll}C${number[1]!.padStart(3, '0')}` : null;
};

/** "C001-C005", "1–5", "C001": the clip numbers a range covers, in order. */
export const expandRange = (from: string, to: string): string[] => {
  const a = /(\d+)\s*$/.exec(from);
  const b = /(\d+)\s*$/.exec(to || from);
  if (!a || !b) return [from];
  const start = Number(a[1]);
  const end = Number(b[1]);
  if (end < start || end - start > 500) return [from];
  const prefix = from.slice(0, a.index);
  const width = a[1]!.length;
  return Array.from({ length: end - start + 1 }, (_, i) => `${prefix}${String(start + i).padStart(width, '0')}`);
};

/** The camera report file VC DIT reads best (any of the script log's column names also work). */
export const REPORT_TEMPLATE = [
  'Roll,Clip,Scene,Setup,Take,Circle,Lens,Notes',
  'A015,C001,14,B,1,,35mm,',
  'A015,C002,14,B,2,Y,35mm,Boom in frame at the end',
  'A015,C003,14,C,1,,50mm,',
  '',
].join('\n');
