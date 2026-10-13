/**
 * Where to send a request that landed on the wrong page carrying Supabase auth
 * parameters. A sign-in link goes wherever Supabase allows; when
 * `/auth/callback` is refused it falls back to the project's Site URL, so the
 * callback must be on the project's redirect allow list (docs/DEPLOYMENT.md).
 * On this site, a stray `code` is forwarded to the callback.
 */
export const CALLBACK_PATH = '/auth/callback';

export const strayAuthRedirect = (url: URL): URL | null => {
  const { pathname, searchParams } = url;
  if (pathname === CALLBACK_PATH || pathname.startsWith('/api/')) return null;

  const code = searchParams.get('code');
  if (code) {
    const remaining = new URLSearchParams(searchParams);
    remaining.delete('code');
    const suffix = remaining.toString();
    const target = new URL(CALLBACK_PATH, url.origin);
    target.searchParams.set('code', code);
    target.searchParams.set('next', pathname === '/' ? '/account' : suffix ? `${pathname}?${suffix}` : pathname);
    return target;
  }

  if (searchParams.has('error_code') || searchParams.get('error') === 'access_denied') {
    return new URL('/signin?error=link_expired', url.origin);
  }
  return null;
};

/** A place on this site to continue to after sign-in, and nothing else. */
export const safeNextPath = (value: string | null | undefined, fallback = '/account'): string =>
  value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : fallback;
