import { describe, expect, it, vi } from 'vitest';
import { keyHint, readKey, sendDay, uploadEndpoint } from '../reports/film-studio-send';

const KEY = `vcdit_${'A1b2_-'.repeat(7)}x9Qa`;
const LOG = '{"schema":"vc-film-studio.dit-day/1"}\n';

/** A stand-in for Film Studio's /api/dit/upload: one answer, and what it was sent. */
const filmStudio = (status: number, body: unknown) => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
    typeof body === 'string' ? new Response(body, { status, headers: { 'content-type': 'text/html' } }) : Response.json(body, { status }),
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls: fetch.mock.calls };
};

describe('the upload key as pasted', () => {
  it('takes the key, without the spaces or a "Bearer" a paste can bring', () => {
    expect(readKey(`  ${KEY}\n`)).toEqual({ ok: true, key: KEY });
    expect(readKey(`Bearer ${KEY}`)).toEqual({ ok: true, key: KEY });
  });

  it('says why a paste is not a key', () => {
    expect(readKey('')).toMatchObject({ ok: false, reason: expect.stringMatching(/Paste the upload key/) });
    expect(readKey(`another_service_${'x'.repeat(40)}`)).toMatchObject({ ok: false, reason: expect.stringMatching(/start with “vcdit_”/) });
    // Cut off in the copy, or two things pasted at once.
    expect(readKey(KEY.slice(0, 20))).toMatchObject({ ok: false, reason: expect.stringMatching(/incomplete/) });
    expect(readKey(`${KEY} ${KEY}`)).toMatchObject({ ok: false, reason: expect.stringMatching(/incomplete/) });
  });

  it('is shown by its last four characters only', () => {
    expect(keyHint(KEY)).toBe('vcdit_…x9Qa');
    expect(keyHint(KEY)).not.toContain(KEY.slice(6, 12));
  });

  it('goes to the site’s upload door, however the site is written', () => {
    expect(uploadEndpoint('https://www.vcfilmstudio.com')).toBe('https://www.vcfilmstudio.com/api/dit/upload');
    expect(uploadEndpoint('https://preview.vercel.app/')).toBe('https://preview.vercel.app/api/dit/upload');
  });
});

describe('sending the day', () => {
  it('posts the log as it is, with the key as a bearer token', async () => {
    const studio = filmStudio(200, { ok: true, production: 'NIGHTJAR', day: { number: 3, matched: true }, says: '4 rolls added, 8 copies added.', warnings: [] });
    const result = await sendDay({ fetch: studio.fetch, endpoint: 'https://www.vcfilmstudio.com/api/dit/upload', key: KEY, log: LOG });
    const [url, init] = studio.calls[0]!;
    expect(url).toBe('https://www.vcfilmstudio.com/api/dit/upload');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(init.body).toBe(LOG);
    expect(result).toEqual({ ok: true, text: 'Day 3 sent to VC Film Studio (NIGHTJAR). 4 rolls added, 8 copies added.', warnings: [] });
  });

  it('passes on what Film Studio warned about', async () => {
    const studio = filmStudio(200, {
      ok: true, production: 'NIGHTJAR', day: { number: 3, matched: false }, says: 'Nothing new — Film Studio already had all of this day.',
      warnings: ['No shoot day in the schedule is dated 2026-10-08; the rolls and notes are recorded without a day.'],
    });
    const result = await sendDay({ fetch: studio.fetch, endpoint: 'x', key: KEY, log: LOG });
    expect(result).toMatchObject({ ok: true, text: expect.stringMatching(/Nothing new/), warnings: [expect.stringMatching(/No shoot day/)] });
  });

  it("shows Film Studio's own sentence when it refuses", async () => {
    const error = 'Film Studio does not recognise that upload key, or it has been revoked. Make a new one on the data desk and paste it into VC DIT.';
    const result = await sendDay({ fetch: filmStudio(401, { ok: false, error }).fetch, endpoint: 'x', key: KEY, log: LOG });
    expect(result).toEqual({ ok: false, reason: error });
    const other = await sendDay({ fetch: filmStudio(409, { ok: false, error: 'This day log is for “NIGHTJAR”, but the key belongs to “EVOLVE”.' }).fetch, endpoint: 'x', key: KEY, log: LOG });
    expect(other).toMatchObject({ ok: false, reason: expect.stringMatching(/belongs to “EVOLVE”/) });
  });

  it('says the day is safe when the cart is offline, Film Studio is slow, or something else answers', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await sendDay({ fetch: offline, endpoint: 'x', key: KEY, log: LOG })).toMatchObject({ ok: false, reason: expect.stringMatching(/Could not reach Film Studio.*sending it again is safe/) });

    const slow = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    expect(await sendDay({ fetch: slow, endpoint: 'x', key: KEY, log: LOG })).toMatchObject({ ok: false, reason: expect.stringMatching(/did not answer in time/) });

    // A hotel wifi sign-in page, or an outage page: not Film Studio's answer, and not a success.
    const portal = await sendDay({ fetch: filmStudio(200, '<html>Sign in to Wi-Fi</html>').fetch, endpoint: 'x', key: KEY, log: LOG });
    expect(portal).toMatchObject({ ok: false, reason: expect.stringMatching(/something unexpected \(HTTP 200\)/) });
    const outage = await sendDay({ fetch: filmStudio(502, { message: 'Bad gateway' }).fetch, endpoint: 'x', key: KEY, log: LOG });
    expect(outage).toMatchObject({ ok: false, reason: expect.stringMatching(/refused the day \(HTTP 502\)/) });
  });
});
