import Stripe from 'stripe';
import { env } from './env';

/** Everything this site creates in Stripe carries this, so the webhook can tell VC DIT's subscriptions from anything else on the account. */
export const PRODUCT_TAG = 'vc-dit';

let cached: Stripe | null = null;

export const stripe = (): Stripe => {
  if (!cached) {
    // Pinned, as VC Writer pins it, so a Stripe-side default cannot change webhook payloads under a deployed build.
    cached = new Stripe(env.stripeSecretKey, { apiVersion: '2025-02-24.acacia' });
  }
  return cached;
};
