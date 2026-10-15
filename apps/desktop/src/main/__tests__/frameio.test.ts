import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProductionDb } from '../db/production-db';
import { FrameioApi } from '../frameio/api';
import { AUTHORIZE_URL, TOKEN_URL, TokenKeeper, authorizeUrl, exchangeCode, pkce, readCallback, refreshTokens } from '../frameio/ims';
import { FrameioPublisher } from '../frameio/publish';
import { partRanges, sendParts } from '../frameio/upload';

const wasm = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
const config = { clientId: 'vcdit-client', redirectUri: 'adobe+abc123://adobeid/vcdit-client', scopes: 'openid offline_access' };
const noSleep = async () => undefined;

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'vcdit-fio-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('signing in through Adobe', () => {
  it('asks for a code with a PKCE challenge, and only takes back a code for its own state', () => {
    const { verifier, challenge } = pkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    const url = new URL(authorizeUrl(config, 'state-1', challenge));
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'vcdit-client',
      redirect_uri: config.redirectUri,
      scope: 'openid offline_access',
      response_type: 'code',
      state: 'state-1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(readCallback(`${config.redirectUri}?code=abc&state=state-1`, 'state-1')).toEqual({ ok: true, code: 'abc' });
    expect(readCallback(`${config.redirectUri}?code=abc&state=other`, 'state-1')).toMatchObject({ ok: false, reason: expect.stringMatching(/another request/) });
    expect(readCallback(`${config.redirectUri}?error=access_denied&state=state-1`, 'state-1')).toEqual({ ok: false, reason: 'Sign-in was cancelled.' });
    expect(readCallback('not a url', 'state-1')).toMatchObject({ ok: false });
  });

  it('trades the code for tokens, refreshes them, and keeps the refresh token Adobe did not rotate', async () => {
    const posted: Record<string, string>[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      expect(url).toBe(TOKEN_URL);
      const body = Object.fromEntries(new URLSearchParams(String(init.body)));
      posted.push(body);
      return body['grant_type'] === 'authorization_code'
        ? json(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 })
        : json(200, { access_token: 'a2', expires_in: 3600 });
    }) as typeof fetch;
    const first = await exchangeCode(fetcher, config, 'the-code', 'the-verifier');
    expect(first).toMatchObject({ accessToken: 'a1', refreshToken: 'r1' });
    expect(posted[0]).toEqual({ grant_type: 'authorization_code', client_id: 'vcdit-client', code: 'the-code', redirect_uri: config.redirectUri, code_verifier: 'the-verifier' });
    expect(await refreshTokens(fetcher, config, first)).toMatchObject({ accessToken: 'a2', refreshToken: 'r1' });
    const refused = (async () => json(400, { error: 'invalid_grant' })) as unknown as typeof fetch;
    await expect(refreshTokens(refused, config, first)).rejects.toMatchObject({ signedOut: true, message: expect.stringMatching(/invalid_grant/) });
  });

  it('refreshes an expiring token once, however many calls want it at the same moment', async () => {
    let refreshes = 0;
    const saved: string[] = [];
    const keeper = new TokenKeeper(
      { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 10_000 },
      async (tokens) => {
        refreshes += 1;
        return { ...tokens, accessToken: `new${refreshes}`, expiresAt: Date.now() + 3_600_000 };
      },
      async (tokens) => void saved.push(tokens.accessToken),
    );
    expect(await Promise.all([keeper.token(), keeper.token(), keeper.token()])).toEqual(['new1', 'new1', 'new1']);
    expect(await keeper.token()).toBe('new1');
    keeper.expire();
    expect(await keeper.token()).toBe('new2');
    expect(saved).toEqual(['new1', 'new2']);
  });
});

describe('the Frame.io API', () => {
  it('waits out rate limits, retries a refused token once with a fresh one, and follows pages', async () => {
    const waits: number[] = [];
    let expired = 0;
    let token = 't1';
    const calls: string[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push(`${String((init.headers as Record<string, string>)['Authorization'])} ${url}`);
      if (url.endsWith('/v4/me')) {
        if (calls.length === 1) return json(429, {}, { 'Retry-After': '3' });
        if (token === 't1') return json(401, {});
        return json(200, { data: { name: 'Dana DIT', email: 'dana@example.com' } });
      }
      if (url.includes('after=2')) return json(200, { data: [{ id: 'c', display_name: 'Third' }], links: { next: null } });
      return json(200, { data: [{ id: 'a', display_name: 'First' }, { id: 'b', display_name: 'Second' }], links: { next: '/v4/accounts?page_size=100&after=2' } });
    }) as typeof fetch;
    const api = new FrameioApi({
      token: async () => token,
      expire: () => {
        expired += 1;
        token = 't2';
      },
      fetch: fetcher,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(await api.me()).toEqual({ name: 'Dana DIT', email: 'dana@example.com' });
    expect(waits).toEqual([3000]);
    expect(expired).toBe(1);
    expect(calls.at(-1)).toBe('Bearer t2 https://api.frame.io/v4/me');
    expect(await api.accounts()).toEqual([
      { id: 'a', name: 'First' },
      { id: 'b', name: 'Second' },
      { id: 'c', name: 'Third' },
    ]);
    const missing = new FrameioApi({ token: async () => 't', fetch: (async () => json(404, { errors: [{ detail: 'Folder not found' }] })) as unknown as typeof fetch, sleep: noSleep });
    await expect(missing.folders('acc', 'gone')).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/Folder not found/) });
  });
});

describe('sending a file in parts', () => {
  it('splits a file as Frame.io asks, or evenly when its sizes do not add up', () => {
    expect(partRanges([{ size: 4, url: 'a' }, { size: 4, url: 'b' }, { size: 2, url: 'c' }], 10)).toEqual([
      { start: 0, length: 4 },
      { start: 4, length: 4 },
      { start: 8, length: 2 },
    ]);
    expect(partRanges([{ size: 0, url: 'a' }, { size: 0, url: 'b' }, { size: 0, url: 'c' }], 10)).toEqual([
      { start: 0, length: 4 },
      { start: 4, length: 4 },
      { start: 8, length: 2 },
    ]);
    expect(() => partRanges([], 10)).toThrow(/no upload address/);
  });

  it('puts every part with the private ACL, tries a failed part again, and stops on an expired address', async () => {
    const path = join(base, 'daily.mov');
    const bytes = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251));
    await writeFile(path, bytes);
    const parts = [0, 1, 2].map((n) => ({ size: [1000, 1000, 500][n]!, url: `https://s3.test/part/${n}` }));
    const received = new Map<string, Buffer>();
    let flaky = 1;
    const fetcher = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(init.method).toBe('PUT');
      expect(headers['x-amz-acl']).toBe('private');
      expect(headers['Content-Type']).toBe('video/quicktime');
      if (url.endsWith('/1') && flaky-- > 0) return new Response(null, { status: 500 });
      received.set(url, Buffer.from(init.body as Uint8Array));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const progress: number[] = [];
    await sendParts(path, parts, bytes.length, 'video/quicktime', { fetch: fetcher, sleep: noSleep, onProgress: (sent) => progress.push(sent) });
    expect(Buffer.concat(parts.map((part) => received.get(part.url)!))).toEqual(bytes);
    expect(progress.at(-1)).toBe(2500);
    const expired = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    await expect(sendParts(path, parts, bytes.length, null, { fetch: expired, sleep: noSleep })).rejects.toThrow(/expired/);
  });
});

/** Frame.io in memory: folders, files, their parts as they arrive, and comments. */
const fakeFrameio = (options: { partSize?: number; failPart?: string | null } = {}) => {
  const partSize = options.partSize ?? 1000;
  const folders = new Map<string, { name: string; parent: string }>([['root', { name: 'HALCYON', parent: '' }]]);
  const files = new Map<string, { name: string; folder: string; size: number; parts: Map<number, Buffer>; count: number; comments: string[] }>();
  let next = 1;
  let failPart = options.failPart ?? null;
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const parsed = new URL(url);
    if (parsed.host === 's3.test') {
      const [, , fileId, index] = parsed.pathname.split('/');
      if (`${fileId}/${index}` === failPart) return new Response(null, { status: 500 });
      files.get(fileId!)!.parts.set(Number(index), Buffer.from(init.body as Uint8Array));
      return new Response(null, { status: 200 });
    }
    const path = parsed.pathname;
    const body = init.body ? (JSON.parse(String(init.body)) as { data: Record<string, unknown> }).data : {};
    let match: RegExpExecArray | null;
    if ((match = /^\/v4\/accounts\/acc\/folders\/([^/]+)\/folders$/.exec(path))) {
      if (method === 'POST') {
        const id = `folder${next++}`;
        folders.set(id, { name: String(body['name']), parent: match[1]! });
        return json(201, { data: { id, name: body['name'] } });
      }
      return json(200, { data: [...folders].filter(([, folder]) => folder.parent === match![1]).map(([id, folder]) => ({ id, name: folder.name })), links: { next: null } });
    }
    if ((match = /^\/v4\/accounts\/acc\/folders\/([^/]+)\/files$/.exec(path))) {
      return json(200, {
        data: [...files]
          .filter(([, file]) => file.folder === match![1])
          .map(([id, file]) => ({ id, name: file.name, type: 'file', file_size: file.size, status: file.parts.size === file.count ? 'uploaded' : 'created', view_url: `https://next.frame.io/view/${id}` })),
        links: { next: null },
      });
    }
    if ((match = /^\/v4\/accounts\/acc\/folders\/([^/]+)\/files\/local_upload$/.exec(path))) {
      const id = `file${next++}`;
      const size = Number(body['file_size']);
      const count = Math.max(1, Math.ceil(size / partSize));
      files.set(id, { name: String(body['name']), folder: match[1]!, size, parts: new Map(), count, comments: [] });
      return json(201, {
        data: {
          id,
          media_type: 'video/quicktime',
          view_url: `https://next.frame.io/view/${id}`,
          upload_urls: Array.from({ length: count }, (_, i) => ({ size: Math.min(partSize, size - i * partSize), url: `https://s3.test/up/${id}/${i}` })),
        },
      });
    }
    if ((match = /^\/v4\/accounts\/acc\/files\/([^/]+)\/status$/.exec(path))) {
      const file = files.get(match[1]!)!;
      return json(200, { data: { id: match[1], upload_complete: file.parts.size === file.count, upload_failed: false } });
    }
    if ((match = /^\/v4\/accounts\/acc\/files\/([^/]+)\/comments$/.exec(path))) {
      files.get(match[1]!)!.comments.push(String(body['text']));
      return json(201, { data: { id: 'c' } });
    }
    if ((match = /^\/v4\/accounts\/acc\/files\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      files.delete(match[1]!);
      return new Response(null, { status: 204 });
    }
    return json(404, { errors: [{ detail: `no route ${method} ${path}` }] });
  }) as typeof fetch;
  const pathOf = (folderId: string): string => {
    const names: string[] = [];
    for (let id = folderId; id && id !== 'root'; id = folders.get(id)!.parent) names.unshift(folders.get(id)!.name);
    return names.join('/');
  };
  return {
    fetch: fetcher,
    files,
    pathOf,
    contents: (id: string) => Buffer.concat([...files.get(id)!.parts].sort(([a], [b]) => a - b).map(([, part]) => part)),
    healPart: () => {
      failPart = null;
    },
  };
};

describe('publishing the day\'s dailies', () => {
  const target = {
    accountId: 'acc',
    accountName: 'Halcyon Films',
    workspaceId: 'ws',
    workspaceName: 'Features',
    projectId: 'p1',
    projectName: 'HALCYON',
    rootFolderId: 'root',
    viewUrl: null,
  };

  const setUp = async () => {
    const db = await ProductionDb.open(join(base, 'p.vcdit'), { wasm, create: { name: 'HALCYON', code: 'HLC' } });
    const day = db.currentDay();
    const daily = async (take: number, size: number, checksum: string) => {
      const output = join(base, `4A-0${take}.mov`);
      await writeFile(output, Buffer.from(Array.from({ length: size }, (_, i) => (i * take) % 256)));
      db.saveRender(day.number, { takeId: `4|A|${take}`, clip: `A001C00${take}`, card: 'A001' }, {
        takeId: `4|A|${take}`,
        label: `4A-0${take}`,
        clip: `A001C00${take}`,
        output,
        state: 'done',
        error: null,
        lut: 'HLC_Show.cube',
        codec: 'ProRes 422 Proxy',
        bytes: size,
        warnings: [],
        checksum,
      });
      return output;
    };
    return { db, day, daily };
  };

  const finished = async (publisher: FrameioPublisher) => {
    for (let i = 0; i < 500 && publisher.busy(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(publisher.busy()).toBe(false);
  };

  it('puts each daily in Dailies / Day / Sc, whole, with its look as a comment, and does not send it twice', async () => {
    const { db, day, daily } = await setUp();
    try {
      await daily(1, 2500, 'aaa');
      await daily(2, 900, 'bbb');
      const frameio = fakeFrameio();
      const publisher = new FrameioPublisher({ db: () => db, session: async () => new FrameioApi({ token: async () => 't', fetch: frameio.fetch, sleep: noSleep }), changed: () => undefined, fetch: frameio.fetch, sleep: noSleep });
      await expect(publisher.start()).rejects.toThrow(/Choose the Frame.io project/);
      db.saveFrameioTarget(target);
      expect(await publisher.start()).toEqual({ files: 2 });
      await finished(publisher);
      expect(publisher.problem).toBeNull();
      const sent = [...frameio.files];
      expect(sent.map(([, file]) => [file.name, frameio.pathOf(file.folder), file.comments])).toEqual([
        ['4A-01.mov', `Dailies/Day 001 · ${day.date}/Sc 4`, ['4A-01 · Look: HLC_Show.cube']],
        ['4A-02.mov', `Dailies/Day 001 · ${day.date}/Sc 4`, ['4A-02 · Look: HLC_Show.cube']],
      ]);
      expect(frameio.contents(sent[0]![0])).toEqual(Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 256)));
      expect(db.renders(day.number).map((render) => render.frameio)).toEqual([
        { state: 'done', error: null, viewUrl: `https://next.frame.io/view/${sent[0]![0]}` },
        { state: 'done', error: null, viewUrl: `https://next.frame.io/view/${sent[1]![0]}` },
      ]);
      // Nothing new: nothing sent. One folder per level, found again by name.
      await expect(publisher.start()).rejects.toThrow(/already on Frame.io/);
      // A re-rendered daily goes again, beside the first.
      await daily(2, 950, 'ccc');
      expect(publisher.pending(day.number).map((item) => item.clip)).toEqual(['A001C002']);
      await publisher.start();
      await finished(publisher);
      expect([...frameio.files.values()].map((file) => file.name)).toEqual(['4A-01.mov', '4A-02.mov', '4A-02.mov']);
      expect(new Set([...frameio.files.values()].map((file) => file.folder)).size).toBe(1);
      // Another project: nothing of it is there yet.
      db.saveFrameioTarget({ ...target, projectId: 'p2' });
      expect(db.renders(day.number).every((render) => render.frameio === undefined)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('records a daily that would not upload, carries on with the rest, and sends it whole next time', async () => {
    const { db, day, daily } = await setUp();
    try {
      db.saveFrameioTarget(target);
      await daily(1, 2500, 'aaa');
      await daily(2, 900, 'bbb');
      // Ids follow creation: the three folders, then the first daily (file4). Its second part fails.
      const frameio = fakeFrameio({ failPart: 'file4/1' });
      const publisher = new FrameioPublisher({ db: () => db, session: async () => new FrameioApi({ token: async () => 't', fetch: frameio.fetch, sleep: noSleep }), changed: () => undefined, fetch: frameio.fetch, sleep: noSleep });
      await publisher.start();
      await finished(publisher);
      expect(publisher.problem).toMatch(/^1 of 2 published\. 4A-01\.mov: Part 2 of 3 would not upload/);
      expect(db.renders(day.number).map((render) => render.frameio?.state)).toEqual(['failed', 'done']);
      frameio.healPart();
      await publisher.start();
      await finished(publisher);
      expect(publisher.problem).toBeNull();
      // The half-made file is gone; the whole one is there.
      const ones = [...frameio.files].filter(([, file]) => file.name === '4A-01.mov');
      expect(ones).toHaveLength(1);
      expect(frameio.contents(ones[0]![0]).length).toBe(2500);
      expect(db.renders(day.number).map((render) => render.frameio?.state)).toEqual(['done', 'done']);
    } finally {
      await db.close();
    }
  });

  it('takes a daily already whole in its folder as published, and needs a sign-in', async () => {
    const { db, day, daily } = await setUp();
    try {
      db.saveFrameioTarget(target);
      await daily(1, 1200, 'aaa');
      const frameio = fakeFrameio();
      const api = new FrameioApi({ token: async () => 't', fetch: frameio.fetch, sleep: noSleep });
      const signedOut = new FrameioPublisher({ db: () => db, session: async () => null, changed: () => undefined });
      await expect(signedOut.start()).rejects.toThrow(/Connect Frame.io first/);
      // A run cut off after the upload, before it was recorded.
      const publisher = new FrameioPublisher({ db: () => db, session: async () => api, changed: () => undefined, fetch: frameio.fetch, sleep: noSleep });
      await publisher.start();
      await finished(publisher);
      // Its record lost, as if the app stopped between the upload and writing it down.
      (db as unknown as { run: (sql: string) => void }).run('delete from frameio_upload');
      expect(publisher.pending(day.number)).toHaveLength(1);
      await publisher.start();
      await finished(publisher);
      expect(frameio.files.size).toBe(1);
      expect(db.renders(day.number)[0]!.frameio?.state).toBe('done');
    } finally {
      await db.close();
    }
  });

  it('publishes on its own after dailies: now, or once the publish under way ends, and says what stops it', async () => {
    const { db, day, daily } = await setUp();
    try {
      expect(db.frameioAuto()).toBe(false);
      db.setFrameioAuto(true);
      expect(db.frameioAuto()).toBe(true);
      db.saveFrameioTarget(target);
      const frameio = fakeFrameio();
      let signedIn = false;
      const publisher = new FrameioPublisher({
        db: () => db,
        session: async () => (signedIn ? new FrameioApi({ token: async () => 't', fetch: frameio.fetch, sleep: noSleep }) : null),
        changed: () => undefined,
        fetch: frameio.fetch,
        sleep: noSleep,
      });
      await daily(1, 1500, 'aaa');
      await publisher.auto();
      expect(publisher.problem).toBe('Not published automatically: Connect Frame.io first.');
      signedIn = true;
      await publisher.auto();
      expect(publisher.busy()).toBe(true);
      // Rendered while that publish runs: it goes when that one ends.
      await daily(2, 700, 'bbb');
      await publisher.auto();
      for (let i = 0; i < 500 && (frameio.files.size < 2 || publisher.busy()); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      await finished(publisher);
      expect([...frameio.files.values()].map((file) => file.name).sort()).toEqual(['4A-01.mov', '4A-02.mov']);
      expect(db.renders(day.number).map((render) => render.frameio?.state)).toEqual(['done', 'done']);
      // Nothing new: nothing to say.
      await publisher.auto();
      expect(publisher.busy()).toBe(false);
      expect(publisher.problem).toBeNull();
    } finally {
      await db.close();
    }
  });
});
