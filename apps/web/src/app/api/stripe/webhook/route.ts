import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { sendLicenseEmail } from '@/lib/email';
import { env } from '@/lib/env';
import { PLANS } from '@/lib/plans';
import { stripe } from '@/lib/stripe';
import { isOurs, recordSubscription, revokeForSubscription } from '@/lib/subscriptions';
import { adminClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stripe webhook: the only place a license is issued or changed.
 *
 * VC Writer's order of operations: verify the signature; claim the event id
 * (in dit_stripe_webhook_events, this endpoint's own table, since VC Writer's
 * endpoint on the shared account sees the same events); act, idempotently;
 * email, whose failure is logged and never fails the webhook.
 *
 * Events that are not VC DIT's (VC Writer's purchases and rooms, VC Game
 * Studio's subscriptions) are acknowledged and left alone before anything is claimed.
 */
export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });

  const payload = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(payload, signature, env.stripeWebhookSecret);
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : 'Signature verification failed' }, { status: 400 });
  }

  const subscriptionEvent =
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted';
  const moneyBack = event.type === 'charge.refunded' || event.type === 'charge.dispute.created';
  if (!subscriptionEvent && !moneyBack) return NextResponse.json({ received: true, ignored: true });
  if (subscriptionEvent && !isOurs(event.data.object as Stripe.Subscription, env.stripePrices)) {
    return NextResponse.json({ received: true, ignored: true });
  }

  const client = adminClient();
  const { error: claimError } = await client.from('dit_stripe_webhook_events').insert({ id: event.id, type: event.type });
  if (claimError) {
    const { data: seen } = await client.from('dit_stripe_webhook_events').select('processed_at').eq('id', event.id).maybeSingle();
    if (seen?.processed_at) return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    if (subscriptionEvent) {
      const record = await recordSubscription(event.data.object as Stripe.Subscription, {
        client,
        prices: env.stripePrices,
        customerEmail: async (customerId) => {
          const customer = await stripe().customers.retrieve(customerId);
          return 'deleted' in customer && customer.deleted ? null : customer.email;
        },
      });
      // Only the delivery that issued the license sends the email; retries stay quiet.
      if (record?.created && record.email) {
        await sendLicenseEmail({ to: record.email, userId: record.userId, serial: record.serial, planName: PLANS[record.plan].name });
      }
    } else {
      // A refund or dispute: follow the money back to its subscription. Other
      // VC products' charges have no subscription of ours and change nothing.
      // Read back through the SDK's pinned API version: newer webhook versions
      // drop `invoice` from the charge, and this is how a refund finds its subscription.
      const object = event.data.object as Stripe.Charge | Stripe.Dispute;
      const chargeId =
        event.type === 'charge.refunded'
          ? (object as Stripe.Charge).id
          : typeof (object as Stripe.Dispute).charge === 'string'
            ? ((object as Stripe.Dispute).charge as string)
            : ((object as Stripe.Dispute).charge as Stripe.Charge).id;
      const charge = await stripe().charges.retrieve(chargeId);
      const invoiceId = typeof charge.invoice === 'string' ? charge.invoice : charge.invoice?.id;
      if (invoiceId) {
        const invoice = await stripe().invoices.retrieve(invoiceId);
        const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
        if (subscriptionId) await revokeForSubscription(client, subscriptionId);
      }
    }

    await client.from('dit_stripe_webhook_events').update({ processed_at: new Date().toISOString() }).eq('id', event.id);
    return NextResponse.json({ received: true });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Handling failed';
    // processed_at stays null, so Stripe's retry runs the (idempotent) handling again.
    await client.from('dit_stripe_webhook_events').update({ error: message }).eq('id', event.id);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
