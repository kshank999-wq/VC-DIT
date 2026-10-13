import { NextResponse } from 'next/server';
import { publicKeyPem } from '@/lib/entitlement';
import { signingKey } from '@/lib/signing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The public half of the license signing key, as PEM. Public by nature: the
 * desktop app checks signatures with it. The release workflow builds it into
 * the installers from here, so the key pair is set up in one place (Vercel's
 * LICENSE_SIGNING_PRIVATE_KEY) and nothing has to be copied to GitHub.
 */
export async function GET(): Promise<Response> {
  try {
    return new Response(publicKeyPem(signingKey()), {
      headers: { 'content-type': 'application/x-pem-file', 'cache-control': 'public, max-age=300' },
    });
  } catch {
    return NextResponse.json({ error: 'LICENSE_SIGNING_PRIVATE_KEY is not set on this deployment' }, { status: 503 });
  }
}
