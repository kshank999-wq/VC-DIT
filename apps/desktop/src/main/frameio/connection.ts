import { app, safeStorage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { FrameioApi } from './api';
import { DEFAULT_SCOPES, REVOKE_URL, TokenKeeper, authorizeUrl, exchangeCode, pkce, readCallback, refreshTokens, type ImsConfig, type Tokens } from './ims';

/**
 * This computer's Frame.io sign-in.
 *
 * The Adobe client id and its redirect come from the build
 * (MAIN_VITE_FRAMEIO_CLIENT_ID, MAIN_VITE_FRAMEIO_REDIRECT_URI: an OAuth
 * Native App credential with the Frame.io API in the Adobe Developer
 * Console; see docs/DEPLOYMENT.md). A build without them cannot connect,
 * and says so.
 *
 * Connecting opens Adobe's sign-in in the person's browser. Adobe sends the
 * code back to the redirect: a custom scheme (adobe+…://…) the app is
 * registered for, which reaches it through `open-url` (macOS) or a second
 * launch (Windows); or a loopback address (http://127.0.0.1:port/…), which
 * the app listens on for the few minutes the sign-in may take.
 *
 * The tokens are the person's, on this computer, not in the production
 * file: kept in the app's folder, sealed by the operating system's keychain
 * (safeStorage) where there is one, and never sent to the screens.
 */

const SIGN_IN_TIMEOUT = 5 * 60_000;

export const frameioConfig = (): ImsConfig | null => {
  const clientId = import.meta.env.MAIN_VITE_FRAMEIO_CLIENT_ID?.trim();
  const redirectUri = import.meta.env.MAIN_VITE_FRAMEIO_REDIRECT_URI?.trim();
  if (!clientId || !redirectUri) return null;
  return { clientId, redirectUri, scopes: import.meta.env.MAIN_VITE_FRAMEIO_SCOPES?.trim() || DEFAULT_SCOPES };
};

const isLoopback = (uri: string) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(uri);
const schemeOf = (uri: string) => /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri)?.[1]?.toLowerCase() ?? null;

const file = () => join(app.getPath('userData'), 'frameio.json');
const seal = (value: string) => (safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(value).toString('base64')}` : value);
const unseal = (value: string): string | null => {
  if (!value.startsWith('enc:')) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
  } catch {
    return null;
  }
};

interface Kept {
  tokens: Tokens;
  user: string;
}

let kept: Kept | null | undefined;
let keeper: TokenKeeper | null = null;

const load = async (): Promise<Kept | null> => {
  if (kept !== undefined) return kept;
  try {
    const raw = JSON.parse(await readFile(file(), 'utf8')) as { sealed?: string; user?: string };
    const opened = raw.sealed ? unseal(raw.sealed) : null;
    kept = opened ? { tokens: JSON.parse(opened) as Tokens, user: raw.user ?? 'Frame.io user' } : null;
  } catch {
    kept = null;
  }
  return kept;
};

const persist = async (next: Kept | null) => {
  kept = next;
  await mkdir(app.getPath('userData'), { recursive: true });
  if (next) await writeFile(file(), JSON.stringify({ sealed: seal(JSON.stringify(next.tokens)), user: next.user }), 'utf8');
  else await rm(file(), { force: true });
};

/** A new sign-in, or none: the token keeper starts again from it. */
const store = async (next: Kept | null) => {
  keeper = null;
  await persist(next);
};

/** Who is signed in on this computer, or null. */
export const frameioUser = async (): Promise<string | null> => (frameioConfig() ? ((await load())?.user ?? null) : null);

/** Frame.io as the signed-in person, or null when no one is. */
export const frameioSession = async (): Promise<FrameioApi | null> => {
  const config = frameioConfig();
  const signedIn = config ? await load() : null;
  if (!config || !signedIn) return null;
  keeper ??= new TokenKeeper(
    signedIn.tokens,
    (tokens) =>
      refreshTokens(fetch, config, tokens).catch(async (cause: Error & { signedOut?: boolean }) => {
        // Adobe will not refresh it: the person signs in again.
        if (cause.signedOut) await store(null);
        throw cause;
      }),
    async (tokens) => {
      if (kept) await persist({ ...kept, tokens });
    },
  );
  const tokens = keeper;
  return new FrameioApi({ token: () => tokens.token(), expire: () => tokens.expire() });
};

// ------------------------------------------------ the redirect back from Adobe

let waiting: { prefix: string; resolve: (url: string) => void } | null = null;

/** A URL the app was opened with (open-url, or a second launch's arguments): Adobe's redirect, when one is awaited. */
export const frameioOpened = (url: string): boolean => {
  if (!waiting || !url.toLowerCase().startsWith(waiting.prefix)) return false;
  waiting.resolve(url);
  return true;
};

/** Register the app for the redirect's custom scheme, when the build uses one. */
export const registerFrameioScheme = () => {
  const config = frameioConfig();
  const scheme = config ? schemeOf(config.redirectUri) : null;
  if (!config || !scheme || isLoopback(config.redirectUri)) return;
  if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(scheme, process.execPath, [process.argv[1]]);
  else app.setAsDefaultProtocolClient(scheme);
};

const awaitRedirect = (redirectUri: string, signal: AbortSignal): Promise<string> =>
  new Promise((resolve, reject) => {
    let server: ReturnType<typeof createServer> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, url?: string) => {
      clearTimeout(timer);
      waiting = null;
      server?.close();
      if (error) reject(error);
      else resolve(url!);
    };
    timer = setTimeout(() => finish(new Error('Frame.io sign-in was not finished in five minutes. Connect again.')), SIGN_IN_TIMEOUT);
    signal.addEventListener('abort', () => finish(new Error('Sign-in cancelled.')), { once: true });
    if (isLoopback(redirectUri)) {
      const target = new URL(redirectUri);
      server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', redirectUri);
        if (url.pathname !== target.pathname) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><meta charset="utf-8"><title>VC DIT</title><body style="font:16px system-ui;padding:40px">Signed in to Frame.io. You can close this tab and go back to VC DIT.</body>');
        finish(null, url.toString());
      });
      server.on('error', (cause) => finish(new Error(`VC DIT could not listen for the sign-in on ${target.host}: ${cause.message}`)));
      server.listen(Number(target.port || 80), target.hostname.replace(/^\[|\]$/g, ''));
    } else {
      waiting = { prefix: redirectUri.toLowerCase().split('?')[0]!.replace(/\/+$/, ''), resolve: (url) => finish(null, url) };
    }
  });

let signingIn: AbortController | null = null;

/** Sign in: Adobe's page in the browser, then back here with a code for tokens. */
export const connectFrameio = async (): Promise<{ ok: true; user: string } | { ok: false; reason: string }> => {
  const config = frameioConfig();
  if (!config) return { ok: false, reason: 'This build of VC DIT is not set up to sign in to Frame.io. See docs/DEPLOYMENT.md (MAIN_VITE_FRAMEIO_CLIENT_ID).' };
  signingIn?.abort();
  const controller = new AbortController();
  signingIn = controller;
  try {
    const state = randomUUID();
    const { verifier, challenge } = pkce();
    const redirect = awaitRedirect(config.redirectUri, controller.signal);
    await shell.openExternal(authorizeUrl(config, state, challenge));
    const read = readCallback(await redirect, state);
    if (!read.ok) return read;
    const tokens = await exchangeCode(fetch, config, read.code, verifier);
    const api = new FrameioApi({ token: async () => tokens.accessToken });
    const me = await api.me();
    await store({ tokens, user: me.email ? `${me.name} (${me.email})` : me.name });
    return { ok: true, user: kept!.user };
  } catch (cause) {
    return { ok: false, reason: (cause as Error).message };
  } finally {
    if (signingIn === controller) signingIn = null;
  }
};

export const cancelFrameioSignIn = () => signingIn?.abort();

/** Sign out on this computer, telling Adobe to forget the tokens too. */
export const disconnectFrameio = async () => {
  const config = frameioConfig();
  const signedIn = await load();
  await store(null);
  if (!config || !signedIn) return;
  for (const token of [signedIn.tokens.refreshToken, signedIn.tokens.accessToken]) {
    if (!token) continue;
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: config.clientId }).toString(),
    }).catch(() => undefined);
  }
};
