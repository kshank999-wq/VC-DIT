import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import type { Interval, Plan, PriceIds } from './env';
import { generateSerial } from './license';
import { licenseStatusFor, planForPrice, type LicenseStatus } from './plans';
import { PRODUCT_TAG } from './stripe';

/**
 * A Stripe subscription, written down: the subscription row, and its license.
 *
 * The only place a license is issued or changed, called from the webhook for
 * every `customer.subscription.*` event. Stripe delivers at least once and in
 * any order, so this is idempotent the way VC Writer's fulfillment is: the
 * subscription row is upserted on Stripe's id, and the license is unique per
 * subscription, so a race between two deliveries collides in Postgres rather
 * than minting two licenses. Every event carries the whole subscription, so
 * the latest one to arrive simply states where it stands — plan (after an
 * upgrade in the billing portal), status and the end of the paid period.
 *
 * Takes its database client and the Stripe lookups as arguments so the money
 * path is tested against fakes.
 */

export interface SubscriptionDeps {
  client: SupabaseClient;
  prices: PriceIds;
  /** The customer's email from Stripe, for a subscription started signed out. */
  customerEmail: (customerId: string) => Promise<string | null>;
  newSerial?: () => string;
  /** Only so tests can fix "now". */
  now?: () => Date;
}

export interface SubscriptionRecord {
  userId: string;
  email: string;
  serial: string;
  plan: Plan;
  interval: Interval;
  status: LicenseStatus;
  /** True only the first time, when the license was issued: the one time to send the email. */
  created: boolean;
}

/** Ours: tagged by this site's checkout, or on one of our four prices. */
export const isOurs = (subscription: Pick<Stripe.Subscription, 'metadata' | 'items'>, prices: PriceIds): boolean =>
  subscription.metadata?.['product'] === PRODUCT_TAG ||
  subscription.items.data.some((item) => planForPrice(prices, item.price.id) !== null);

const findProfileByEmail = async (client: SupabaseClient, email: string): Promise<string | null> => {
  const { data } = await client.from('profiles').select('id').ilike('email', email).maybeSingle();
  return (data?.id as string | undefined) ?? null;
};

/**
 * The account this subscription belongs to: the signed-in customer who
 * started checkout, or the account for the checkout's email. Someone who
 * checked out signed out gets an account for their email, so a paid
 * subscription is never stranded.
 */
const resolveUser = async (client: SupabaseClient, metadataUserId: string | undefined, email: string): Promise<string> => {
  if (metadataUserId) return metadataUserId;
  const existing = await findProfileByEmail(client, email);
  if (existing) return existing;
  const { data: created, error } = await client.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { source: 'vc-dit-checkout' },
  });
  if (created?.user) return created.user.id;
  const raced = await findProfileByEmail(client, email);
  if (raced) return raced;
  throw new Error(`Could not create or find an account for ${email}: ${error?.message ?? 'unknown error'}`);
};

const iso = (seconds: number | null | undefined): string | null =>
  typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;

export const recordSubscription = async (
  subscription: Stripe.Subscription,
  deps: SubscriptionDeps,
): Promise<SubscriptionRecord | null> => {
  const { client, prices } = deps;
  if (!isOurs(subscription, prices)) return null;

  const item = subscription.items.data.find((candidate) => planForPrice(prices, candidate.price.id) !== null);
  const which = item ? planForPrice(prices, item.price.id) : null;
  if (!item || !which) throw new Error(`Subscription ${subscription.id} is not on a VC DIT price`);

  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const metadataUserId = subscription.metadata?.['supabase_user_id'] || undefined;
  const email = (await deps.customerEmail(customerId))?.trim().toLowerCase() ?? '';
  if (!email && !metadataUserId) throw new Error(`Subscription ${subscription.id} has no customer email`);
  const userId = await resolveUser(client, metadataUserId, email);

  // Stripe moved the billing period from the subscription to its items in API
  // version 2025-03-31 (basil); a webhook endpoint set to a newer version than
  // this SDK's sends it there. Either place is the same period.
  const itemPeriodEnd = (item as unknown as { current_period_end?: number }).current_period_end;
  const paidThrough = iso(subscription.current_period_end ?? itemPeriodEnd);
  const { data: row, error: rowError } = await client
    .from('subscriptions')
    .upsert(
      {
        user_id: userId,
        stripe_subscription_id: subscription.id,
        stripe_customer_id: customerId,
        stripe_price_id: item.price.id,
        plan: which.plan,
        billing_interval: which.interval,
        status: subscription.status,
        current_period_end: paidThrough,
        cancel_at_period_end: subscription.cancel_at_period_end,
      },
      { onConflict: 'stripe_subscription_id' },
    )
    .select('id')
    .single();
  if (rowError || !row) throw new Error(`Could not record subscription ${subscription.id}: ${rowError?.message}`);

  const { data: existing } = await client
    .from('licenses')
    .select('id, serial, status')
    .eq('subscription_id', row.id)
    .maybeSingle();

  if (existing) {
    const status = licenseStatusFor(subscription.status, existing.status as LicenseStatus);
    const { error } = await client
      .from('licenses')
      .update({ plan: which.plan, status, paid_through: paidThrough })
      .eq('id', existing.id);
    if (error) throw new Error(`Could not update license ${existing.serial}: ${error.message}`);
    return { userId, email, serial: existing.serial as string, plan: which.plan, interval: which.interval, status, created: false };
  }

  const status = licenseStatusFor(subscription.status);
  const { data: license, error: licenseError } = await client
    .from('licenses')
    .insert({
      user_id: userId,
      subscription_id: row.id,
      serial: (deps.newSerial ?? generateSerial)(),
      plan: which.plan,
      status,
      paid_through: paidThrough,
    })
    .select('id, serial')
    .single();

  if (licenseError || !license) {
    // A concurrent delivery won unique(subscription_id); read its license.
    const { data: raced } = await client.from('licenses').select('serial').eq('subscription_id', row.id).maybeSingle();
    if (raced) return { userId, email, serial: raced.serial as string, plan: which.plan, interval: which.interval, status, created: false };
    throw new Error(`Could not issue a license for subscription ${subscription.id}: ${licenseError?.message}`);
  }

  return { userId, email, serial: license.serial as string, plan: which.plan, interval: which.interval, status, created: true };
};

/** A refund or dispute takes the license with it, and it stays revoked. */
export const revokeForSubscription = async (client: SupabaseClient, stripeSubscriptionId: string): Promise<boolean> => {
  const { data: row } = await client
    .from('subscriptions')
    .select('id')
    .eq('stripe_subscription_id', stripeSubscriptionId)
    .maybeSingle();
  if (!row) return false;
  const { error } = await client.from('licenses').update({ status: 'revoked' }).eq('subscription_id', row.id);
  return !error;
};
