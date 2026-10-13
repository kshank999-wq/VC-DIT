import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Two clients, as in VC Writer. `serverClient()` acts as the signed-in visitor
 * and is bound by row level security; `adminClient()` uses the service role
 * and is the only way subscriptions, licenses, seats and releases are written.
 */

export const serverClient = () => {
  const cookieStore = cookies();
  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      get: (name: string) => cookieStore.get(name)?.value,
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // A Server Component cannot set cookies; the middleware refreshes them instead.
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: '', ...options });
        } catch {
          // As above.
        }
      },
    },
  });
};

let cachedAdmin: SupabaseClient | null = null;

/** Service-role client. Never import this from a client component. */
export const adminClient = (): SupabaseClient => {
  if (!cachedAdmin) {
    cachedAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cachedAdmin;
};

export const currentUser = async () => {
  const { data } = await serverClient().auth.getUser();
  return data.user ?? null;
};

/**
 * Who is calling: the session cookie on the site, or a bearer token from the
 * desktop app, which signs in to the same Supabase project.
 */
export const callerFrom = async (request: Request): Promise<{ id: string; email: string } | null> => {
  const header = request.headers.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    const { data } = await adminClient().auth.getUser(header.slice(7).trim());
    return data.user ? { id: data.user.id, email: data.user.email ?? '' } : null;
  }
  const user = await currentUser();
  return user ? { id: user.id, email: user.email ?? '' } : null;
};
