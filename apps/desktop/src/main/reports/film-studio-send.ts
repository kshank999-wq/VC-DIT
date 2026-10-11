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
