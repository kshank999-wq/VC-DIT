import { NextResponse } from 'next/server';
import { z } from 'zod';
import { canDownload, loadAccount } from '@/lib/account';
import { codeMayDownload } from '@/lib/activation-service';
import { env } from '@/lib/env';
import { RULES, rateLimit } from '@/lib/rate-limit';
import { adminClient, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ code: z.string().min(1).max(60) });

/**
 * A download of the current installer for one platform. Never a permanent
 * public URL: every request re-checks the license and mints a short-lived
 * signed URL, so a leaked link dies within minutes.
 *
 * Two ways in. POST with the authorization code from the purchase email (no
 * sign-in: the download page's form, and what a cart with no email on it
 * uses). GET as the signed-in subscriber (the account page's buttons).
 */
const mint = async (platform: 'windows' | 'macos'): Promise<Response> => {
  const client = adminClient();
  const { data: build, error } = await client
    .from('release_builds')
    .select('version, artifact_key, sha256, minimum_os_version')
    .eq('platform', platform)
    .eq('channel', 'stable')
    .eq('active', true)
    .maybeSingle();
  if (error) return NextResponse.json({ error: 'Could not read the releases' }, { status: 500 });
  if (!build) return NextResponse.json({ error: 'No published build for this platform yet' }, { status: 404 });

  const { data: signed, error: signError } = await client.storage
    .from(env.releaseBucket)
    .createSignedUrl(build.artifact_key as string, env.releaseDownloadTtlSeconds, { download: true });
  if (signError || !signed) return NextResponse.json({ error: 'Could not prepare the download' }, { status: 500 });

  return NextResponse.json({
    url: signed.signedUrl,
    version: build.version,
    sha256: build.sha256,
    minimumOsVersion: build.minimum_os_version,
  });
};

const platformOf = (value: string): 'windows' | 'macos' | null => (value === 'windows' || value === 'macos' ? value : null);

export async function POST(request: Request, { params }: { params: { platform: string } }): Promise<Response> {
  const platform = platformOf(params.platform);
  if (!platform) return NextResponse.json({ error: 'Unknown platform' }, { status: 404 });
  const limited = await rateLimit(request, RULES.download);
  if (limited) return limited;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Enter your authorization code' }, { status: 400 });
  if (!(await codeMayDownload(parsed.data.code, adminClient()))) {
    return NextResponse.json(
      { error: 'That authorization code is not on an active subscription. Check your purchase email, or see vc-dit.com/account.' },
      { status: 403 },
    );
  }
  return mint(platform);
}

export async function GET(_request: Request, { params }: { params: { platform: string } }): Promise<Response> {
  const platform = platformOf(params.platform);
  if (!platform) return NextResponse.json({ error: 'Unknown platform' }, { status: 404 });
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Sign in, or use your authorization code on the download page' }, { status: 401 });
  if (!canDownload(await loadAccount(adminClient(), user.id))) {
    return NextResponse.json({ error: 'Downloads come with an active subscription' }, { status: 403 });
  }
  return mint(platform);
}
