import type { Interval, Plan, PriceIds } from './env';

/**
 * The plan and the rules that turn a Stripe subscription into a license. Pure,
 * so the money path is tested without Stripe or a database.
 *
 * VC DIT is one plan, monthly ($9.99) or yearly ($99). The amounts live in
 * Stripe (`npm run setup -- stripe --monthly=9.99 --yearly=99`), not here.
 */

export const PLAN: { id: Plan; name: string; tagline: string; features: string[] } = {
  id: 'dit',
  name: 'VC DIT',
  tagline: 'Verified ingest to delivery, built around the way a DIT works on set.',
  features: [
    'Checksum-verified copies to several destinations at once',
    'Camera and sound cards detected as they mount',
    'Scene / setup / take folders built from the script supervisor log',
    'Picture and sound sync by timecode, with waveform fallback',
    'Production LUTs applied to dailies, never to camera originals',
    'VFX shots mirrored into their own scene / setup tree',
    'Delivery to drives, NAS, Frame.io and cloud destinations, with manifests',
  ],
};

export const PLANS: Record<Plan, typeof PLAN> = { dit: PLAN };

/** Two computers per subscription: the DIT cart and a second (a wrangler's station, or a laptop). */
export const DEVICES_PER_LICENSE = 2;

export const isInterval = (value: unknown): value is Interval => value === 'month' || value === 'year';

export const priceIdFor = (prices: PriceIds, interval: Interval): string => prices[interval];

/** Which plan and interval a Stripe price is, or null for a price that is not ours. */
export const planForPrice = (prices: PriceIds, priceId: string): { plan: Plan; interval: Interval } | null => {
  for (const interval of ['month', 'year'] as const) {
    if (prices[interval] === priceId) return { plan: 'dit', interval };
  }
  return null;
};

export type LicenseStatus = 'active' | 'suspended' | 'revoked' | 'expired';

/**
 * A license follows its subscription.
 *
 * Active while Stripe says the subscription is in good standing, and also
 * while it is `past_due`: that is Stripe retrying a card, and a DIT whose
 * renewal failed mid-shoot must not lose ingest that afternoon. Once Stripe
 * gives up (`unpaid`, `canceled`, `incomplete_expired`) the license expires.
 * `incomplete` is a first payment not yet through, so it is not active yet. A
 * license revoked for a refund or dispute stays revoked whatever the
 * subscription does next.
 */
export const licenseStatusFor = (stripeStatus: string, current: LicenseStatus | null = null): LicenseStatus => {
  if (current === 'revoked') return 'revoked';
  if (stripeStatus === 'active' || stripeStatus === 'trialing' || stripeStatus === 'past_due') return 'active';
  if (stripeStatus === 'incomplete' || stripeStatus === 'paused') return 'suspended';
  return 'expired';
};
