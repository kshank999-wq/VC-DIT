import { NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { priceIdFor } from '@/lib/plans';
import { RULES, rateLimit } from '@/lib/rate-limit';
import { PRODUCT_TAG, stripe } from '@/lib/stripe';
import { adminClient, currentUser } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ interval: z.enum(['month', 'year']) });

/**
 * Start a subscription checkout. The client names monthly or yearly; the
 * price is the server's. Nothing is granted here — the license comes from the
 * webhook once Stripe says the subscription exists.
 *
 * Signing in first is required, so the subscription lands on the right account
 * from the start (one VC account across VC Writer, VC Game Studio and VC DIT).
 * A returning customer reuses their Stripe customer, so their cards and
 * invoices stay in one place.
 */
export async function POST(request: Request): Promise<Response> {
  const limited = await rateLimit(request, RULES.checkout);
  if (limited) return limited;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Choose monthly or yearly' }, { status: 400 });

  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Sign in first', signIn: true }, { status: 401 });

  try {
    const { data: previous } = await adminClient()
      .from('dit_subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();
    const metadata = { product: PRODUCT_TAG, supabase_user_id: user.id, plan: 'dit' };
    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceIdFor(env.stripePrices, parsed.data.interval), quantity: 1 }],
      success_url: `${env.siteUrl}/purchase/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.siteUrl}/pricing?cancelled=1`,
      ...(previous?.stripe_customer_id
        ? { customer: previous.stripe_customer_id as string, customer_update: { address: 'auto' as const } }
        : user.email
          ? { customer_email: user.email }
          : {}),
      client_reference_id: user.id,
      // On the session and, through subscription_data, on the subscription and
      // its events: how VC Writer's webhook on the shared account knows to skip them.
      metadata,
      subscription_data: { metadata },
      allow_promotion_codes: true,
      // Only once Stripe Tax is set up on the account (STRIPE_AUTOMATIC_TAX=1).
      automatic_tax: { enabled: env.stripeAutomaticTax },
      billing_address_collection: 'auto',
    });
    if (!session.url) return NextResponse.json({ error: 'Stripe did not return a checkout URL' }, { status: 502 });
    return NextResponse.json({ url: session.url });
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : 'Checkout could not be started' }, { status: 500 });
  }
}
