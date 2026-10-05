/**
 * Environment access, as in VC Writer: every value is read lazily and fails
 * loudly where it is used, so a missing Stripe key breaks checkout and not the
 * marketing pages or a build that has no secrets.
 */

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const optional = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

export const DEFAULT_SITE_URL = 'https://vc-dit.com';

/**
 * The site's own origin, absolute and without a trailing slash. Forgiving,
 * unlike everything else: the root layout reads it at module scope, so a typo
 * (or the variable's name pasted in as its value, which happened to VC Writer)
 * must warn and fall back rather than fail the build.
 */
export const parseSiteUrl = (raw: string | undefined): string => {
  const value = raw?.trim();
  if (!value) return DEFAULT_SITE_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    console.warn(`NEXT_PUBLIC_SITE_URL is not a URL (${JSON.stringify(value)}); using ${DEFAULT_SITE_URL}.`);
    return DEFAULT_SITE_URL;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    console.warn(`NEXT_PUBLIC_SITE_URL must be http or https (${JSON.stringify(value)}); using ${DEFAULT_SITE_URL}.`);
    return DEFAULT_SITE_URL;
  }
  return parsed.href.replace(/\/+$/, '');
};

export const env = {
  get supabaseUrl(): string {
    return required('NEXT_PUBLIC_SUPABASE_URL');
  },
  get supabaseAnonKey(): string {
    return required('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  },
  /** Server only. Bypasses row level security. */
  get supabaseServiceRoleKey(): string {
    return required('SUPABASE_SERVICE_ROLE_KEY');
  },
  get stripeSecretKey(): string {
    return required('STRIPE_SECRET_KEY');
  },
  get stripeWebhookSecret(): string {
    return required('STRIPE_WEBHOOK_SECRET');
  },
  /** The two recurring prices of the one plan: monthly and yearly. */
  get stripePrices(): PriceIds {
    return { month: required('STRIPE_PRICE_MONTHLY'), year: required('STRIPE_PRICE_YEARLY') };
  },
  /**
   * This product's own customer portal (made by `npm run setup -- stripe`).
   * Not the account default, which VC Writer's Writers Room uses; without it
   * the portal falls back to that default, so set it before selling.
   */
  get stripePortalConfiguration(): string | undefined {
    return process.env['STRIPE_PORTAL_CONFIGURATION']?.trim() || undefined;
  },
  /**
   * Whether checkout asks Stripe Tax to calculate tax. Off unless set to 1: a
   * checkout that asks for it on an account without Stripe Tax set up fails,
   * so it is switched on only once Settings → Tax is active.
   */
  get stripeAutomaticTax(): boolean {
    return ['1', 'true', 'on', 'yes'].includes((process.env['STRIPE_AUTOMATIC_TAX'] ?? '').trim().toLowerCase());
  },
  get resendApiKey(): string {
    return required('RESEND_API_KEY');
  },
  get resendFrom(): string {
    return optional('RESEND_FROM_ADDRESS', 'VC DIT <noreply@vc-dit.com>');
  },
  /** Ed25519 private key (PKCS#8 PEM, or the same base64-encoded) that signs desktop entitlements. */
  get licenseSigningKey(): string {
    return required('LICENSE_SIGNING_PRIVATE_KEY');
  },
  get releaseBucket(): string {
    return optional('RELEASE_BUCKET', 'dit-releases');
  },
  get releaseDownloadTtlSeconds(): number {
    return Number.parseInt(optional('RELEASE_DOWNLOAD_TTL_SECONDS', '900'), 10);
  },
  get siteUrl(): string {
    return parseSiteUrl(process.env['NEXT_PUBLIC_SITE_URL']);
  },
} as const;

/** One plan today; a type rather than a constant so a second (VC VFX Prep, say) is an addition, not a rewrite. */
export type Plan = 'dit';
export type Interval = 'month' | 'year';
export type PriceIds = Record<Interval, string>;

export const SITE_NAME = 'VC DIT';
