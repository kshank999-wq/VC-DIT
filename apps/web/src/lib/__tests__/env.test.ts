import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SITE_URL, env, parseSiteUrl } from '../env';

describe('site url', () => {
  it('keeps a good URL without its trailing slash', () => {
    expect(parseSiteUrl('https://vc-dit.com/')).toBe('https://vc-dit.com');
    expect(parseSiteUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('falls back, warning, on the mistakes that took VC Writer down', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSiteUrl('NEXT_PUBLIC_SITE_URL')).toBe(DEFAULT_SITE_URL);
    expect(parseSiteUrl('ftp://vc-dit.com')).toBe(DEFAULT_SITE_URL);
    expect(parseSiteUrl(undefined)).toBe(DEFAULT_SITE_URL);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('automatic tax', () => {
  it('is off until STRIPE_AUTOMATIC_TAX is switched on', () => {
    const before = process.env['STRIPE_AUTOMATIC_TAX'];
    delete process.env['STRIPE_AUTOMATIC_TAX'];
    expect(env.stripeAutomaticTax).toBe(false);
    process.env['STRIPE_AUTOMATIC_TAX'] = '1';
    expect(env.stripeAutomaticTax).toBe(true);
    process.env['STRIPE_AUTOMATIC_TAX'] = 'no';
    expect(env.stripeAutomaticTax).toBe(false);
    if (before === undefined) delete process.env['STRIPE_AUTOMATIC_TAX'];
    else process.env['STRIPE_AUTOMATIC_TAX'] = before;
  });
});
