'use client';

import { createBrowserClient } from '@supabase/ssr';

/** Browser client: the publishable key only, bound by row level security. */
export const browserClient = () =>
  createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '');
