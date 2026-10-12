/**
 * Sending the day straight to VC Film Studio: the same log "Export to VC
 * Film Studio…" writes, posted to the production's data desk with an upload
 * key made there (Film Studio → Data → From VC DIT → Send from the cart).
 *
 *   POST https://www.vcfilmstudio.com/api/dit/upload
 *   Authorization: Bearer vcdit_…
 *   <the vc-film-studio.dit-day/1 log>
 *
 * Film Studio imports it all at once or not at all, and a day sent twice adds
 * nothing the second time, so "send again" is always the right advice after a
 * failure. Every answer here is one sentence the DIT can act on.
 *
 * No Electron in this file: the network and the key come in as arguments so
 * the tests can stand in for Film Studio.
 */

export const KEY_PREFIX = 'vcdit_';
/** 32 random bytes in base64url after the prefix; anything much shorter was cut off in the paste. */
const KEY_SHAPE = /^vcdit_[A-Za-z0-9_-]{40,}$/;

export const FILM_STUDIO_URL = 'https://www.vcfilmstudio.com';
export const uploadEndpoint = (site: string) => `${site.replace(/\/+$/, '')}/api/dit/upload`;

/** The key as pasted, or why it is not one: a stray space or a missing piece is the usual reason. */
export const readKey = (input: string): { ok: true; key: string } | { ok: false; reason: string } => {
  const key = input.trim().replace(/^Bearer\s+/i, '');
  if (!key) return { ok: false, reason: 'Paste the upload key from Film Studio’s data desk.' };
  if (!key.startsWith(KEY_PREFIX)) return { ok: false, reason: 'That is not a Film Studio upload key — they start with “vcdit_”. Copy it again from the data desk.' };
  if (!KEY_SHAPE.test(key)) return { ok: false, reason: 'That key is incomplete or has extra characters in it. Copy the whole key again from the data desk.' };
  return { ok: true, key };
};

/** "vcdit_…x9Qa": enough to tell two keys apart on screen, never enough to use. */
export const keyHint = (key: string) => `${KEY_PREFIX}…${key.slice(-4)}`;

export type SendResult =
  | { ok: true; text: string; warnings: string[] }
  | { ok: false; reason: string };

interface Answer {
  ok?: boolean;
  error?: string;
  production?: string;
  day?: { number?: number; matched?: boolean };
  says?: string;
  warnings?: string[];
}

const SAFE_AGAIN = 'Nothing is lost — the day is still here, and sending it again is safe.';

export async function sendDay(options: {
  fetch: typeof fetch;
  endpoint: string;
  key: string;
  log: string;
  timeoutMs?: number;
}): Promise<SendResult> {
  let response: Response;
  try {
    response = await options.fetch(options.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.key}`, 'content-type': 'application/json' },
      body: options.log,
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
    return {
      ok: false,
      reason: timedOut
        ? `Film Studio did not answer in time. ${SAFE_AGAIN}`
        : `Could not reach Film Studio — check the cart is online. ${SAFE_AGAIN}`,
    };
  }

  let answer: Answer | null = null;
  try {
    answer = (await response.json()) as Answer;
  } catch {
    // A proxy, a captive portal or an outage page: not Film Studio's answer.
  }
  if (!answer || typeof answer !== 'object') {
    return { ok: false, reason: `Film Studio sent back something unexpected (HTTP ${response.status}). ${SAFE_AGAIN}` };
  }
  if (!response.ok || answer.ok !== true) {
    // Film Studio's refusals are already sentences meant for the cart.
    return { ok: false, reason: answer.error || `Film Studio refused the day (HTTP ${response.status}). ${SAFE_AGAIN}` };
  }

  // A day Film Studio could not place on its schedule comes back as a warning, shown under this.
  const day = answer.day?.number ? `Day ${answer.day.number}` : 'The day';
  const where = answer.production ? ` (${answer.production})` : '';
  return {
    ok: true,
    text: `${day} sent to VC Film Studio${where}. ${answer.says ?? ''}`.trim(),
    warnings: Array.isArray(answer.warnings) ? answer.warnings.filter((w): w is string => typeof w === 'string') : [],
  };
}

// ------------------------------------------------ the camera report, the other way

export const cameraReportEndpoint = (site: string) => `${site.replace(/\/+$/, '')}/api/dit/camera-report`;

/** One camera report line as VC DIT keeps it: the roll is the card. */
export interface PulledLine {
  card: string;
  clip: string;
  scene: string;
  setup: string;
  take: string;
  circle: boolean;
  lens: string;
  notes: string;
}

export type PullResult =
  | { ok: true; production: string; day: number | null; lines: PulledLine[] }
  | { ok: false; reason: string };

const str = (value: unknown, max: number) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : '');

/**
 * Film Studio's line to VC DIT's. VC DIT keeps no stop or filter column, so
 * they go in front of the notes, where the day report shows them.
 */
export const pulledLine = (raw: unknown): PulledLine | null => {
  const line = (raw ?? {}) as Record<string, unknown>;
  const card = str(line['roll'], 24).toUpperCase();
  const clip = str(line['clip'], 60).toUpperCase();
  const scene = str(line['scene'], 12).toUpperCase();
  const take = str(line['take'], 6);
  if (!card || !clip || !scene || !take) return null;
  const notes = [str(line['stop'], 16), str(line['filter'], 40), str(line['notes'], 400)].filter(Boolean).join(' · ');
  return { card, clip, scene, setup: str(line['setup'], 8).toUpperCase(), take, circle: line['circle'] === true, lens: str(line['lens'], 40), notes };
};

/**
 * The day's camera report from Film Studio, found by the day's date and then
 * its number, with the same upload key the day is sent with.
 */
export async function fetchCameraReport(options: {
  fetch: typeof fetch;
  endpoint: string;
  key: string;
  date: string;
  day: number;
  timeoutMs?: number;
}): Promise<PullResult> {
  const url = `${options.endpoint}?${new URLSearchParams({ date: options.date, day: String(options.day) })}`;
  let response: Response;
  try {
    response = await options.fetch(url, {
      headers: { authorization: `Bearer ${options.key}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'Film Studio did not answer in time. Try again in a moment.' : 'Could not reach Film Studio — check the cart is online.' };
  }
  type Answer = { ok?: boolean; error?: string; production?: string; day?: { number?: number }; lines?: unknown };
  let answer: Answer | null = null;
  try {
    answer = (await response.json()) as Answer;
  } catch {
    // Not Film Studio's answer.
  }
  if (!answer || typeof answer !== 'object') {
    return { ok: false, reason: `Film Studio sent back something unexpected (HTTP ${response.status}).` };
  }
  if (!response.ok || answer.ok !== true) {
    return { ok: false, reason: answer.error || `Film Studio refused (HTTP ${response.status}).` };
  }
  const lines = (Array.isArray(answer.lines) ? answer.lines : []).map(pulledLine).filter((line): line is PulledLine => line !== null);
  return { ok: true, production: answer.production ?? '', day: typeof answer.day?.number === 'number' ? answer.day.number : null, lines };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a pull did, in one or two sentences. */
export const pullNote = (lines: number, result: { cards: string[]; rows: number; kept: string[]; removed: string[] }): string => {
  if (lines === 0 && result.removed.length === 0) return 'Film Studio has no camera report for this day yet.';
  const parts: string[] = [];
  parts.push(result.cards.length
    ? `From Film Studio: ${plural(result.rows, 'line')} on ${plural(result.cards.length, 'roll')} (${result.cards.join(', ')}).`
    : 'Nothing new taken from Film Studio.');
  if (result.kept.length) {
    parts.push(`${result.kept.join(', ')} ${result.kept.length === 1 ? 'was' : 'were'} entered or imported here, so ${result.kept.length === 1 ? 'it was' : 'they were'} kept. Clear ${result.kept.length === 1 ? 'that roll' : 'those rolls'} to take Film Studio’s instead.`);
  }
  if (result.removed.length) parts.push(`${result.removed.join(', ')} ${result.removed.length === 1 ? 'is' : 'are'} no longer on Film Studio’s report, so ${result.removed.length === 1 ? 'it was' : 'they were'} taken out.`);
  return parts.join(' ');
};
