import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { strayAuthRedirect } from '@/lib/auth-redirect';

/**
 * Refreshes the Supabase session cookie on navigation and sets a nonce-based
 * content security policy, as VC Writer's middleware does. The static files and
 * the Stripe webhook are outside it.
 */
const contentSecurityPolicy = (nonce: string): string => {
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabase} ${supabase.replace(/^https:/, 'wss:')}`.trim(),
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
};

export async function middleware(request: NextRequest) {
  const stray = strayAuthRedirect(request.nextUrl);
  if (stray) return NextResponse.redirect(stray);

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', {
    cookies: {
      get: (name: string) => request.cookies.get(name)?.value,
      set: (name: string, value: string, options: CookieOptions) => {
        response.cookies.set({ name, value, ...options });
      },
      remove: (name: string, options: CookieOptions) => {
        response.cookies.set({ name, value: '', ...options });
      },
    },
  });
  // Without keys (a preview deployment, CI) the site still renders, signed out.
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|api/stripe).*)'],
};
