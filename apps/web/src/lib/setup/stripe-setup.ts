import type Stripe from 'stripe';
import type { Interval } from '../env';
import { PLAN } from '../plans';

/**
 * Stripe for VC DIT, made in one go and safe to run again: the product,
 * its monthly and yearly prices, the webhook endpoint, and a customer
 * portal configuration of its own.
 *
 * The portal is this product's own configuration rather than the account's
 * default, because the account is shared: VC Writer's Writers Room sends its
 * customers to the default portal, and they must not be offered VC DIT
 * prices to switch to. /api/billing/portal names this configuration.
 */

export const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'charge.refunded',
  'charge.dispute.created',
];

export type Amounts = Record<Interval, number>;

export const lookupKey = (interval: Interval): string => `vcdit_${interval}`;

const ENV_KEY: Record<Interval, string> = { month: 'STRIPE_PRICE_MONTHLY', year: 'STRIPE_PRICE_YEARLY' };

/** `--monthly=9.99 --yearly=99`, in whole or decimal currency units. */
export const parseAmounts = (args: string[]): Amounts => {
  const read = (name: string): number => {
    const raw = args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
    const value = raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Give a price: --${name}=<amount>, e.g. --monthly=9.99 --yearly=99`);
    return Math.round(value * 100);
  };
  return { month: read('monthly'), year: read('yearly') };
};

export interface StripeSetupResult {
  env: Record<string, string>;
  notes: string[];
}

export const setupStripe = async (
  stripe: Stripe,
  options: { amounts: Amounts; currency: string; siteUrl: string },
): Promise<StripeSetupResult> => {
  const env: Record<string, string> = {};
  const notes: string[] = [];
  const priceIds: Record<Interval, string> = { month: '', year: '' };

  const found = await stripe.products.search({ query: `metadata['vcdit_plan']:'${PLAN.id}'` });
  const product =
    found.data.find((candidate) => candidate.active) ??
    (await stripe.products.create({
      name: PLAN.name,
      description: PLAN.tagline,
      metadata: { product: 'vc-dit', vcdit_plan: PLAN.id },
    }));
  if (found.data.length === 0) notes.push(`Created the product ${PLAN.name}.`);

  for (const interval of ['month', 'year'] as const) {
    const key = lookupKey(interval);
    const amount = options.amounts[interval];
    const existing = (await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 })).data[0];
    const reusable =
      existing && existing.unit_amount === amount && existing.currency === options.currency && existing.product === product.id;
    const price = reusable
      ? existing
      : await stripe.prices.create({
          product: product.id,
          currency: options.currency,
          unit_amount: amount,
          recurring: { interval },
          lookup_key: key,
          // A new amount takes the key over; customers already on the old price stay on it.
          transfer_lookup_key: true,
          tax_behavior: 'exclusive',
          metadata: { product: 'vc-dit', vcdit_plan: PLAN.id },
        });
    if (!reusable) notes.push(`Price ${PLAN.name} ${interval}ly: ${(amount / 100).toFixed(2)} ${options.currency.toUpperCase()}.`);
    priceIds[interval] = price.id;
    env[ENV_KEY[interval]] = price.id;
  }

  const url = `${options.siteUrl}/api/stripe/webhook`;
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const endpoint = endpoints.data.find((candidate) => candidate.url === url);
  if (!endpoint) {
    const created = await stripe.webhookEndpoints.create({
      url,
      enabled_events: WEBHOOK_EVENTS,
      description: 'VC DIT (vc-dit.com): subscriptions and licenses',
      api_version: '2025-02-24.acacia',
      metadata: { product: 'vc-dit' },
    });
    if (created.secret) env['STRIPE_WEBHOOK_SECRET'] = created.secret;
    notes.push(`Created the webhook ${url}.`);
  } else {
    await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: WEBHOOK_EVENTS });
    notes.push(`The webhook ${url} already exists; its signing secret is in the Stripe dashboard (Webhooks → the endpoint → Reveal) if the env file lacks it.`);
  }

  const features: Stripe.BillingPortal.ConfigurationCreateParams.Features = {
    customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id'] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: 'at_period_end' },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ['price'],
      proration_behavior: 'create_prorations',
      products: [{ product: product.id, prices: [priceIds.month, priceIds.year] }],
    },
  };
  const configurations = await stripe.billingPortal.configurations.list({ limit: 100 });
  const mine = configurations.data.find((candidate) => candidate.metadata?.['product'] === 'vc-dit');
  const portal = mine
    ? await stripe.billingPortal.configurations.update(mine.id, { features })
    : await stripe.billingPortal.configurations.create({
        business_profile: { headline: 'VC DIT: your plan, card and invoices' },
        features,
        default_return_url: `${options.siteUrl}/account`,
        metadata: { product: 'vc-dit' },
      });
  env['STRIPE_PORTAL_CONFIGURATION'] = portal.id;
  notes.push(`${mine ? 'Updated' : 'Created'} the VC DIT customer portal (not the account default, which VC Writer uses).`);
  return { env, notes };
};
