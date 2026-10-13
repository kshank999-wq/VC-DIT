import { describe, expect, it } from 'vitest';
import { safeNextPath, strayAuthRedirect } from '../auth-redirect';

describe('auth redirects', () => {
  it('forwards a stray code to the callback, continuing where it landed', () => {
    expect(strayAuthRedirect(new URL('https://vc-dit.com/?code=abc'))?.toString()).toBe(
      'https://vc-dit.com/auth/callback?code=abc&next=%2Faccount',
    );
    expect(strayAuthRedirect(new URL('https://vc-dit.com/download?code=abc'))?.searchParams.get('next')).toBe('/download');
  });

  it('sends an expired link to sign-in, and leaves the callback and APIs alone', () => {
    expect(strayAuthRedirect(new URL('https://x.test/?error=access_denied&error_code=otp_expired'))?.pathname).toBe('/signin');
    expect(strayAuthRedirect(new URL('https://x.test/auth/callback?code=abc'))).toBeNull();
    expect(strayAuthRedirect(new URL('https://x.test/api/releases?code=abc'))).toBeNull();
  });

  it('only continues to places on this site', () => {
    expect(safeNextPath('/pricing')).toBe('/pricing');
    expect(safeNextPath('https://evil.test')).toBe('/account');
    expect(safeNextPath('//evil.test')).toBe('/account');
    expect(safeNextPath('/\\evil')).toBe('/account');
  });
});
