import { NextResponse } from 'next/server';
import { safeNextPath } from '@/lib/auth-redirect';
import { serverClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Exchanges the sign-in link's code for a session cookie, then continues. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const destination = safeNextPath(url.searchParams.get('next'));
  if (code) {
    const { error } = await serverClient().auth.exchangeCodeForSession(code);
    if (error) {
      // Spent, or opened in another browser than the one that asked for it.
      const back = new URL('/signin', url.origin);
      back.searchParams.set('error', 'link_expired');
      back.searchParams.set('next', destination);
      return NextResponse.redirect(back);
    }
  }
  return NextResponse.redirect(new URL(destination, url.origin));
}
