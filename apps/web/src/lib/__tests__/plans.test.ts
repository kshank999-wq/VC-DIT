import { describe, expect, it } from 'vitest';
import { DEVICES_PER_LICENSE, isInterval, licenseStatusFor, planForPrice, priceIdFor } from '../plans';

const prices = { month: 'price_m', year: 'price_y' };

describe('the plan', () => {
  it('maps the two prices both ways, and ignores everyone else’s', () => {
    expect(priceIdFor(prices, 'year')).toBe('price_y');
    expect(planForPrice(prices, 'price_m')).toEqual({ plan: 'dit', interval: 'month' });
    expect(planForPrice(prices, 'price_vcwriter_desktop')).toBeNull();
    expect(isInterval('year') && !isInterval('week')).toBe(true);
  });

  it('runs on two computers', () => {
    expect(DEVICES_PER_LICENSE).toBe(2);
  });

  it('keeps a license active through a retried card, and ends it when Stripe gives up', () => {
    expect(licenseStatusFor('active')).toBe('active');
    expect(licenseStatusFor('trialing')).toBe('active');
    expect(licenseStatusFor('past_due')).toBe('active');
    expect(licenseStatusFor('incomplete')).toBe('suspended');
    expect(licenseStatusFor('canceled')).toBe('expired');
    expect(licenseStatusFor('unpaid')).toBe('expired');
    expect(licenseStatusFor('incomplete_expired')).toBe('expired');
  });

  it('never un-revokes a refunded license', () => {
    expect(licenseStatusFor('active', 'revoked')).toBe('revoked');
    expect(licenseStatusFor('active', 'expired')).toBe('active');
  });
});
