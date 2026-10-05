import { NextResponse } from 'next/server';
import { loadAccount } from '@/lib/account';
import { sendLicenseReminder } from '@/lib/email';
import { PLANS } from '@/lib/plans';
import { RULES, rateLimit } from '@/lib/rate-limit';
import { adminClient, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Email the authorization code again, to the account's own address only. */
export async function POST(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user?.email) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });
  const limited = await rateLimit(request, RULES.email, undefined, user.id);
  if (limited) return limited;
  const sub = (await loadAccount(adminClient(), user.id)).find((candidate) => candidate.license);
  if (!sub?.license) return NextResponse.json({ error: 'No authorization code on this account yet' }, { status: 404 });
  const { sent } = await sendLicenseReminder({ to: user.email, userId: user.id, serial: sub.license.serial, planName: PLANS[sub.plan].name });
  return sent ? NextResponse.json({ sent: true }) : NextResponse.json({ error: 'The email could not be sent; your authorization code is on this page.' }, { status: 502 });
}
