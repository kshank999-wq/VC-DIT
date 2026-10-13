import { createHash, randomBytes } from 'node:crypto';

/**
 * Signing in to Frame.io (V4), which signs in through Adobe IMS: OAuth 2.0
 * authorization code with PKCE, as a native app. No client secret is in the
 * app; the person signs in in their own browser, and Adobe sends the code
 * back to the app's redirect (the custom scheme Adobe assigns to a Native App
 * credential, or a loopback address). The access token is refreshed with the
 * refresh token for as long as Adobe allows (offline_access).
 *
 * The endpoints and default scopes are those of Frame.io's own SDKs.
 */

export const IMS_BASE = 'https://ims-na1.adobelogin.com';
export const AUTHORIZE_URL = `${IMS_BASE}/ims/authorize/v2`;
export const TOKEN_URL = `${IMS_BASE}/ims/token/v3`;
export const REVOKE_URL = `${IMS_BASE}/ims/revoke`;
export const DEFAULT_SCOPES = 'openid email profile offline_access additional_info.roles';

export interface ImsConfig {
  clientId: string;
  redirectUri: string;
  scopes: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
}

type Fetch = typeof fetch;

const base64url = (buffer: Buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier (43–128 unreserved characters) and its S256 challenge. */
export const pkce = (): { verifier: string; challenge: string } => {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
};

export const authorizeUrl = (config: ImsConfig, state: string, challenge: string): string =>
  `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()}`;

/** The code from Adobe's redirect, once its state is ours; or why there is none. */
export const readCallback = (url: string, state: string): { ok: true; code: string } | { ok: false; reason: string } => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'The sign-in came back unreadable.' };
  }
  const params = parsed.searchParams;
  if (params.get('state') !== state) return { ok: false, reason: 'The sign-in came back for another request. Try again.' };
  const error = params.get('error');
  if (error) return { ok: false, reason: error === 'access_denied' ? 'Sign-in was cancelled.' : `Adobe refused the sign-in: ${params.get('error_description') ?? error}.` };
  const code = params.get('code');
  return code ? { ok: true, code } : { ok: false, reason: 'The sign-in came back without a code.' };
};

const tokenRequest = async (fetcher: Fetch, body: Record<string, string>): Promise<Tokens> => {
  let response: Response;
  try {
    response = await fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  } catch {
    throw new Error('Adobe sign-in could not be reached. Check the internet connection.');
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof json['access_token'] !== 'string') {
    const why = typeof json['error_description'] === 'string' ? json['error_description'] : typeof json['error'] === 'string' ? json['error'] : `HTTP ${response.status}`;
    const error = new Error(`Adobe sign-in failed: ${why}.`);
    (error as Error & { signedOut?: boolean }).signedOut = response.status === 400 || response.status === 401;
    throw error;
  }
  const expiresIn = typeof json['expires_in'] === 'number' && json['expires_in'] > 0 ? json['expires_in'] : 86400;
  return {
    accessToken: json['access_token'],
    refreshToken: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : null,
    expiresAt: Date.now() + expiresIn * 1000,
  };
};

export const exchangeCode = (fetcher: Fetch, config: ImsConfig, code: string, verifier: string): Promise<Tokens> =>
  tokenRequest(fetcher, { grant_type: 'authorization_code', client_id: config.clientId, code, redirect_uri: config.redirectUri, code_verifier: verifier });

export const refreshTokens = async (fetcher: Fetch, config: ImsConfig, tokens: Tokens): Promise<Tokens> => {
  if (!tokens.refreshToken) {
    const error = new Error('The Frame.io sign-in has expired. Connect again.');
    (error as Error & { signedOut?: boolean }).signedOut = true;
    throw error;
  }
  const next = await tokenRequest(fetcher, { grant_type: 'refresh_token', client_id: config.clientId, refresh_token: tokens.refreshToken });
  // Adobe may or may not rotate the refresh token.
  return { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken };
};

/** Tokens good for at least another minute, refreshed when not; one refresh at a time. */
export class TokenKeeper {
  private refreshing: Promise<Tokens> | null = null;

  constructor(
    private tokens: Tokens,
    private readonly refresh: (tokens: Tokens) => Promise<Tokens>,
    private readonly saved: (tokens: Tokens) => Promise<void>,
  ) {}

  async token(): Promise<string> {
    if (this.tokens.expiresAt - Date.now() > 60_000) return this.tokens.accessToken;
    this.refreshing ??= this.refresh(this.tokens)
      .then(async (next) => {
        this.tokens = next;
        await this.saved(next);
        return next;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return (await this.refreshing).accessToken;
  }

  /** After a 401: the token is no good whatever its expiry says. */
  expire() {
    this.tokens = { ...this.tokens, expiresAt: 0 };
  }
}
