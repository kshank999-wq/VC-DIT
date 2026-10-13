import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deactivateByCode, deactivateDevice, listDevices } from '@/lib/activation-service';
import { RULES, rateLimit } from '@/lib/rate-limit';
import { adminClient, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The computers using the signed-in account's seats, and the ones that used to. */
export async function GET(): Promise<Response> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Sign in to see your computers' }, { status: 401 });
  return NextResponse.json({ devices: await listDevices(user.id, adminClient()) });
}

const deleteSchema = z.union([
  z.object({ activationId: z.string().uuid() }),
  z.object({ code: z.string().min(1).max(60), fingerprint: z.string().min(16).max(200) }),
]);

/**
 * Free a seat. From the account page (signed in), any of the account's
 * computers: the lost-laptop case. From the app, its own, by its code and
 * fingerprint. The record is kept, marked freed.
 */
export async function DELETE(request: Request): Promise<Response> {
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Which computer?' }, { status: 400 });

  if ('activationId' in parsed.data) {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Sign in to manage your computers' }, { status: 401 });
    const result = await deactivateDevice(user.id, parsed.data.activationId, adminClient());
    return result.ok ? NextResponse.json({ deactivated: true }) : NextResponse.json({ error: result.error }, { status: 400 });
  }

  const limited = await rateLimit(request, RULES.activate);
  if (limited) return limited;
  const result = await deactivateByCode(parsed.data.code, parsed.data.fingerprint, adminClient());
  return result.ok ? NextResponse.json({ deactivated: true }) : NextResponse.json({ error: result.error }, { status: 400 });
}
