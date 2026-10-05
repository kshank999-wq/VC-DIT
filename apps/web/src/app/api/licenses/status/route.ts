import { NextResponse } from 'next/server';
import { z } from 'zod';
import { checkDevice } from '@/lib/activation-service';
import { deviceSchema } from '@/lib/device-input';
import { RULES, rateLimit } from '@/lib/rate-limit';
import { signingKey } from '@/lib/signing';
import { adminClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = deviceSchema.extend({ code: z.string().min(1).max(60) });

/**
 * The desktop app's regular check (at start and every few hours while it is
 * open): a fresh entitlement while this computer is on an active license, and
 * the reason when it is not.
 */
export async function POST(request: Request): Promise<Response> {
  const limited = await rateLimit(request, RULES.status);
  if (limited) return limited;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'An authorization code and a device are required' }, { status: 400 });

  const { code, ...device } = parsed.data;
  const result = await checkDevice(code, device, adminClient(), signingKey());
  if (!result.ok) return NextResponse.json({ error: result.message, reason: result.reason }, { status: result.reason === 'error' ? 500 : 409 });
  return NextResponse.json({ token: result.token, entitlement: result.entitlement });
}
