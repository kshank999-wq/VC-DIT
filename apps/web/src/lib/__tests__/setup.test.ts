import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { missingVariables, parseEnv, upsertEnv } from '../setup/env-file';
import { setupResend, vercelRecord } from '../setup/resend-setup';
import { lookupKey, parseAmounts, setupStripe, WEBHOOK_EVENTS } from '../setup/stripe-setup';
import { addRedirect, carriesCode, setupSupabaseAuth } from '../setup/supabase-auth-setup';
import { envPayload, setupVercel } from '../setup/vercel-setup';

describe('the env file', () => {
  it('sets keys in place, appends new ones and leaves the rest', () => {
    const text = '# comment\nSTRIPE_SECRET_KEY=sk_live_1\nOTHER="a b"\n';
    const next = upsertEnv(text, { STRIPE_SECRET_KEY: 'sk_live_2', STRIPE_PRICE_WRITER_MONTHLY: 'price_1', RESEND_FROM_ADDRESS: 'VC DIT <noreply@vc-dit.com>' });
    expect(next).toBe('# comment\nSTRIPE_SECRET_KEY=sk_live_2\nOTHER="a b"\nSTRIPE_PRICE_WRITER_MONTHLY=price_1\nRESEND_FROM_ADDRESS="VC DIT <noreply@vc-dit.com>"\n');
    expect(parseEnv(next)).toMatchObject({ OTHER: 'a b', RESEND_FROM_ADDRESS: 'VC DIT <noreply@vc-dit.com>' });
  });

  it('says what is still missing', () => {
    expect(missingVariables({ STRIPE_SECRET_KEY: 'x' })).toContain('STRIPE_WEBHOOK_SECRET');
    expect(missingVariables({ STRIPE_SECRET_KEY: 'x' })).not.toContain('RELEASE_BUCKET');
  });
});

/** A Stripe stand-in holding what the setup creates, to run it twice. */
const fakeStripe = () => {
  let n = 0;
  const id = (prefix: string) => `${prefix}_${++n}`;
  const products: Stripe.Product[] = [];
  const prices: Stripe.Price[] = [];
  const endpoints: Stripe.WebhookEndpoint[] = [];
  const portals: Stripe.BillingPortal.Configuration[] = [];
  const stripe = {
    products: {
      search: async ({ query }: { query: string }) => ({ data: products.filter((p) => query.includes(`'${p.metadata['vcdit_plan']}'`)) }),
      create: async (params: Stripe.ProductCreateParams) => {
        const product = { id: id('prod'), active: true, ...params } as unknown as Stripe.Product;
        products.push(product);
        return product;
      },
    },
    prices: {
      list: async ({ lookup_keys }: { lookup_keys: string[] }) => ({ data: prices.filter((p) => p.active && lookup_keys.includes(p.lookup_key ?? '')) }),
      create: async (params: Stripe.PriceCreateParams) => {
        for (const old of prices) if (old.lookup_key === params.lookup_key) old.lookup_key = null;
        const price = { id: id('price'), active: true, ...params } as unknown as Stripe.Price;
        prices.push(price);
        return price;
      },
    },
    webhookEndpoints: {
      list: async () => ({ data: endpoints }),
      create: async (params: Stripe.WebhookEndpointCreateParams) => {
        const endpoint = { id: id('we'), secret: 'whsec_test', ...params } as unknown as Stripe.WebhookEndpoint;
        endpoints.push(endpoint);
        return endpoint;
      },
      update: async () => ({}),
    },
    billingPortal: {
      configurations: {
        list: async () => ({ data: portals }),
        create: async (params: Stripe.BillingPortal.ConfigurationCreateParams) => {
          const portal = { id: id('bpc'), ...params } as unknown as Stripe.BillingPortal.Configuration;
          portals.push(portal);
          return portal;
        },
        update: async (portalId: string, params: Record<string, unknown>) => Object.assign(portals.find((p) => p.id === portalId)!, params),
      },
    },
  } as unknown as Stripe;
  return { stripe, products, prices, endpoints, portals };
};

describe('stripe setup', () => {
  const amounts = parseAmounts(['--monthly=9.99', '--yearly=99']);

  it('reads prices in currency units', () => {
    expect(amounts).toEqual({ month: 999, year: 9900 });
    expect(() => parseAmounts(['--monthly=9.99'])).toThrow(/yearly/);
  });

  it('makes the product, two prices, the webhook and a portal of its own, and nothing twice', async () => {
    const fake = fakeStripe();
    const first = await setupStripe(fake.stripe, { amounts, currency: 'usd', siteUrl: 'https://vc-dit.com' });
    expect(fake.products).toHaveLength(1);
    expect(fake.prices.map((p) => [p.lookup_key, p.unit_amount])).toEqual([[lookupKey('month'), 999], [lookupKey('year'), 9900]]);
    expect(fake.prices.every((p) => p.recurring && p.metadata?.['product'] === 'vc-dit')).toBe(true);
    expect(fake.endpoints[0]).toMatchObject({ url: 'https://vc-dit.com/api/stripe/webhook', enabled_events: WEBHOOK_EVENTS });
    expect(fake.portals[0]?.metadata).toEqual({ product: 'vc-dit' });
    const switching = (fake.portals[0] as unknown as Stripe.BillingPortal.ConfigurationCreateParams).features.subscription_update;
    expect((switching?.products as { prices: string[] }[]).flatMap((p) => p.prices)).toHaveLength(2);
    expect(first.env).toMatchObject({ STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_PORTAL_CONFIGURATION: fake.portals[0]?.id });
    expect(first.env['STRIPE_PRICE_YEARLY']).toBe(fake.prices[1]?.id);

    const again = await setupStripe(fake.stripe, { amounts, currency: 'usd', siteUrl: 'https://vc-dit.com' });
    expect(fake.products).toHaveLength(1);
    expect(fake.prices).toHaveLength(2);
    expect(fake.endpoints).toHaveLength(1);
    expect(fake.portals).toHaveLength(1);
    expect(again.env['STRIPE_PRICE_YEARLY']).toBe(first.env['STRIPE_PRICE_YEARLY']);
    expect(again.env['STRIPE_WEBHOOK_SECRET']).toBeUndefined();
  });

  it('a new amount is a new price that takes the lookup key over', async () => {
    const fake = fakeStripe();
    await setupStripe(fake.stripe, { amounts, currency: 'usd', siteUrl: 'https://vc-dit.com' });
    const raised = await setupStripe(fake.stripe, { amounts: { ...amounts, month: 1299 }, currency: 'usd', siteUrl: 'https://vc-dit.com' });
    expect(fake.prices).toHaveLength(3);
    expect(raised.env['STRIPE_PRICE_MONTHLY']).toBe(fake.prices[2]?.id);
  });
});

/** Answers by method and URL; records every call. */
const fakeFetch = (routes: Record<string, (body: unknown) => [number, unknown]>) => {
  const calls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.replace(/\?teamId=[^&]+$/, '').replace(/&teamId=[^&]+$/, '')}`;
    calls.push(key);
    const route = routes[key];
    const [status, body] = route ? route(init?.body ? JSON.parse(String(init.body)) : undefined) : [404, {}];
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetcher, calls };
};

describe('resend setup', () => {
  const records = [
    { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=abc' },
    { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
  ];

  it('adds the domain, puts its records in Vercel DNS and asks for verification', async () => {
    const posted: unknown[] = [];
    const { fetcher, calls } = fakeFetch({
      'GET https://api.resend.com/domains': () => [200, { data: [] }],
      'POST https://api.resend.com/domains': () => [200, { id: 'd1', name: 'vc-dit.com', status: 'not_started' }],
      'GET https://api.resend.com/domains/d1': () => [200, { status: 'not_started', records }],
      'GET https://api.vercel.com/v4/domains/vc-dit.com/records': () => [200, { records: [{ name: 'resend._domainkey', type: 'TXT', value: 'p=abc' }] }],
      'POST https://api.vercel.com/v2/domains/vc-dit.com/records': (body) => (posted.push(body), [200, {}]),
      'POST https://api.resend.com/domains/d1/verify': () => [200, {}],
    });
    await setupResend(fetcher, { resendKey: 're_x', domain: 'vc-dit.com', vercelToken: 'vt', vercelTeamId: 'team_1' });
    expect(posted).toEqual([{ name: 'send', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', ttl: 60, mxPriority: 10 }]);
    expect(calls).toContain('POST https://api.resend.com/domains/d1/verify');
  });

  it('names records relative to the domain, as Vercel wants', () => {
    expect(vercelRecord({ record: '', name: 'send.vc-dit.com', type: 'TXT', value: 'v' }, 'vc-dit.com').name).toBe('send');
    expect(vercelRecord({ record: '', name: 'vc-dit.com', type: 'TXT', value: 'v' }, 'vc-dit.com').name).toBe('');
  });
});

describe('supabase sign-in settings', () => {
  it("adds this site's callback and keeps VC Writer's", () => {
    expect(addRedirect('https://vc-writer.com/auth/callback', 'https://vc-dit.com/auth/callback')).toEqual({
      list: 'https://vc-writer.com/auth/callback,https://vc-dit.com/auth/callback',
      changed: true,
    });
    expect(addRedirect('https://vc-dit.com/auth/callback', 'https://vc-dit.com/auth/callback').changed).toBe(false);
    expect(carriesCode('<p>Code: {{ .Token }}</p>')).toBe(true);
    expect(carriesCode('<a href="{{ .ConfirmationURL }}">Sign in</a>')).toBe(false);
  });

  it('patches only the redirect list, and reports on the email', async () => {
    let patched: unknown = null;
    const url = 'https://api.supabase.com/v1/projects/ref/config/auth';
    const { fetcher } = fakeFetch({
      [`GET ${url}`]: () => [200, { uri_allow_list: 'https://vc-writer.com/auth/callback', mailer_templates_magic_link_content: '<a href="{{ .ConfirmationURL }}">x</a>' }],
      [`PATCH ${url}`]: (body) => ((patched = body), [200, {}]),
    });
    const result = await setupSupabaseAuth(fetcher, { accessToken: 't', projectRef: 'ref', callbackUrl: 'https://vc-dit.com/auth/callback' });
    expect(patched).toEqual({ uri_allow_list: 'https://vc-writer.com/auth/callback,https://vc-dit.com/auth/callback' });
    expect(result.codeInEmail).toBe(false);
  });
});

describe('vercel setup', () => {
  it('uploads secrets as sensitive and the rest encrypted, skipping empty ones', () => {
    const payload = envPayload({ STRIPE_SECRET_KEY: 'sk', NEXT_PUBLIC_SITE_URL: 'https://vc-dit.com', RESEND_API_KEY: '', VERCEL_TOKEN: 'never' });
    expect(payload).toEqual([
      { key: 'STRIPE_SECRET_KEY', value: 'sk', type: 'sensitive', target: ['production', 'preview'] },
      { key: 'NEXT_PUBLIC_SITE_URL', value: 'https://vc-dit.com', type: 'encrypted', target: ['production', 'preview'] },
    ]);
  });

  it('creates the project with the right root, attaches the domain and www, uploads the variables', async () => {
    const bodies: Record<string, unknown> = {};
    const { fetcher, calls } = fakeFetch({
      'GET https://api.vercel.com/v9/projects/vc-dit': () => [404, {}],
      'POST https://api.vercel.com/v11/projects': (body) => ((bodies['create'] = body), [200, { id: 'prj_1' }]),
      'PATCH https://api.vercel.com/v9/projects/prj_1': (body) => ((bodies['patch'] = body), [200, {}]),
      'POST https://api.vercel.com/v10/projects/prj_1/domains': () => [200, {}],
      'POST https://api.vercel.com/v10/projects/prj_1/env?upsert=true': (body) => ((bodies['env'] = body), [200, {}]),
    });
    await setupVercel(fetcher, { token: 't', teamId: 'team_1', projectName: 'vc-dit', repo: 'kshank999-wq/VC-DIT', domain: 'vc-dit.com', env: { STRIPE_SECRET_KEY: 'sk' } });
    expect(bodies['create']).toMatchObject({ rootDirectory: 'apps/web', framework: 'nextjs', gitRepository: { type: 'github', repo: 'kshank999-wq/VC-DIT' } });
    expect(bodies['patch']).toMatchObject({ sourceFilesOutsideRootDirectory: true });
    expect(calls.filter((call) => call.endsWith('/domains'))).toHaveLength(2);
    expect(bodies['env']).toEqual([{ key: 'STRIPE_SECRET_KEY', value: 'sk', type: 'sensitive', target: ['production', 'preview'] }]);
  });
});
