/**
 * The one local file the setup steps share: apps/web/.env.production.local
 * (git-ignored). Each step reads what it needs from it and writes back what it
 * learns — price ids, the webhook secret, the license key — so the Vercel step
 * can upload the lot and nothing is copied by hand.
 */

export const parseEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match?.[1]) continue;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
};

const quote = (value: string): string => (/[\s#"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);

/** Sets keys in place where they already are, appends the rest, and leaves every other line alone. */
export const upsertEnv = (text: string, entries: Record<string, string>): string => {
  const pending = new Map(Object.entries(entries));
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
  const next = lines.map((line) => {
    const key = /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1];
    if (!key || !pending.has(key)) return line;
    const value = pending.get(key) as string;
    pending.delete(key);
    return `${key}=${quote(value)}`;
  });
  for (const [key, value] of pending) next.push(`${key}=${quote(value)}`);
  return `${next.join('\n')}\n`;
};

/** The variables vc-dit.com needs (docs/DEPLOYMENT.md), with which are secret. */
export const SITE_VARIABLES: { key: string; secret: boolean; required: boolean }[] = [
  { key: 'NEXT_PUBLIC_SUPABASE_URL', secret: false, required: true },
  { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', secret: false, required: true },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', secret: true, required: true },
  { key: 'STRIPE_SECRET_KEY', secret: true, required: true },
  { key: 'STRIPE_WEBHOOK_SECRET', secret: true, required: true },
  { key: 'STRIPE_PRICE_MONTHLY', secret: false, required: true },
  { key: 'STRIPE_PRICE_YEARLY', secret: false, required: true },
  { key: 'STRIPE_PORTAL_CONFIGURATION', secret: false, required: true },
  { key: 'RESEND_API_KEY', secret: true, required: true },
  { key: 'RESEND_FROM_ADDRESS', secret: false, required: true },
  { key: 'LICENSE_SIGNING_PRIVATE_KEY', secret: true, required: true },
  { key: 'NEXT_PUBLIC_SITE_URL', secret: false, required: true },
  { key: 'STRIPE_AUTOMATIC_TAX', secret: false, required: false },
  { key: 'RELEASE_BUCKET', secret: false, required: false },
  { key: 'RELEASE_DOWNLOAD_TTL_SECONDS', secret: false, required: false },
  { key: 'RATE_LIMIT_SALT', secret: true, required: false },
  { key: 'ELECTRON_SKIP_BINARY_DOWNLOAD', secret: false, required: false },
];

export const missingVariables = (env: Record<string, string>): string[] =>
  SITE_VARIABLES.filter((variable) => variable.required && !env[variable.key]?.trim()).map((variable) => variable.key);
