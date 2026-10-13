import { env, type Interval } from './env';
import { stripe } from './stripe';

/**
 * Prices, read from Stripe rather than repeated here (VC Writer's rule): Stripe
 * is what the customer is charged, and a second copy would one day disagree.
 * Null when Stripe is not configured, so the pages still render and the price
 * simply appears at checkout.
 */

export type DisplayPrices = Partial<Record<Interval, string>>;

export const formatPrice = (amountCents: number, currency: string): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
  }).format(amountCents / 100);

export const fetchDisplayPrices = async (): Promise<DisplayPrices | null> => {
  try {
    const ids = env.stripePrices;
    const out: DisplayPrices = {};
    await Promise.all(
      (['month', 'year'] as const).map(async (interval) => {
        const price = await stripe().prices.retrieve(ids[interval]);
        if (price.unit_amount != null && price.currency) out[interval] = formatPrice(price.unit_amount, price.currency);
      }),
    );
    return out;
  } catch {
    return null;
  }
};
