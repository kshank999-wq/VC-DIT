import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { stripe } from '@/lib/stripe';
import { adminClient, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stripe's customer portal: switch monthly and yearly, update the card, read
 * invoices, cancel. Stripe's own rather than a screen here, as VC Writer does
 * for its rooms; whatever changes comes back through the webhook.
 */
export async function POST(): Promise<Response> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });
  const { data } = await adminClient()
    .from('dit_subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.stripe_customer_id) return NextResponse.json({ error: 'No subscription on this account yet' }, { status: 404 });
  try {
    const session = await stripe().billingPortal.sessions.create({
      customer: data.stripe_customer_id as string,
      return_url: `${env.siteUrl}/account`,
      // VC DIT's own portal (monthly and yearly), not VC Writer's default one.
      ...(env.stripePortalConfiguration ? { configuration: env.stripePortalConfiguration } : {}),
    });
    return NextResponse.json({ url: session.url });
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : 'The billing page could not be opened' }, { status: 500 });
  }
}
