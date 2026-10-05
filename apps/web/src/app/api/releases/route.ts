import { NextResponse } from 'next/server';
import { adminClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The current version per platform, public, for anything that wants to say
 * which version is out (an update notice in the app, later). Versions and
 * notes only — never where the installer is.
 */
export async function GET(): Promise<Response> {
  try {
    const { data } = await adminClient()
      .from('dit_release_builds')
      .select('platform, version, minimum_os_version, release_notes, published_at')
      .eq('channel', 'stable')
      .eq('active', true);
    return NextResponse.json({ releases: data ?? [] }, { headers: { 'cache-control': 'public, max-age=300' } });
  } catch {
    return NextResponse.json({ releases: [] });
  }
}
