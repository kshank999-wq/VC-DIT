/**
 * Sets up the services vc-dit.com runs on, one step at a time, each safe
 * to run again. Everything is read from and written to apps/web/.env.production.local
 * (git-ignored); docs/DEPLOYMENT.md walks through the order.
 *
 *   npm run setup -w @vcdit/web -- keys
 *   npm run setup -w @vcdit/web -- stripe --monthly=9.99 --yearly=99 [--currency=usd]
 *   npm run setup -w @vcdit/web -- resend        (VERCEL_TOKEN in the file adds the DNS records too)
 *   npm run setup -w @vcdit/web -- supabase      (needs SUPABASE_ACCESS_TOKEN, a personal access token)
 *   npm run setup -w @vcdit/web -- vercel        (needs VERCEL_TOKEN)
 *   npm run setup -w @vcdit/web -- check
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Stripe from 'stripe';
import { missingVariables, parseEnv, upsertEnv } from '../src/lib/setup/env-file';
import { setupResend } from '../src/lib/setup/resend-setup';
import { parseAmounts, setupStripe } from '../src/lib/setup/stripe-setup';
import { setupSupabaseAuth } from '../src/lib/setup/supabase-auth-setup';
import { setupVercel } from '../src/lib/setup/vercel-setup';

const FILE = resolve(import.meta.dirname, '../.env.production.local');
const SITE = 'https://vc-dit.com';
const DOMAIN = 'vc-dit.com';
const TEAM = 'team_u7MT4rqOzxUsxMI5gdYsbVN0';

const read = (): Record<string, string> => (existsSync(FILE) ? parseEnv(readFileSync(FILE, 'utf8')) : {});
const write = (entries: Record<string, string>) => {
  writeFileSync(FILE, upsertEnv(existsSync(FILE) ? readFileSync(FILE, 'utf8') : '', entries), { mode: 0o600 });
};
const need = (env: Record<string, string>, key: string): string => {
  const value = env[key] ?? process.env[key];
  if (!value) throw new Error(`Put ${key} in ${FILE} first.`);
  return value;
};
const say = (lines: string[]) => lines.forEach((line) => console.log(`· ${line}`));

const [step, ...args] = process.argv.slice(2);
const env = read();
// The vc-dit Supabase project's ref (Supabase → Project Settings → General → Project ID).
const SUPABASE_REF = env['SUPABASE_PROJECT_REF'] ?? process.env['SUPABASE_PROJECT_REF'] ?? 'wdpbzwqzjpxabvfailly';

const DEFAULTS = {
  ...(SUPABASE_REF ? { NEXT_PUBLIC_SUPABASE_URL: `https://${SUPABASE_REF}.supabase.co` } : {}),
  NEXT_PUBLIC_SITE_URL: SITE,
  RESEND_FROM_ADDRESS: `VC DIT <noreply@${DOMAIN}>`,
  ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
};

switch (step) {
  case 'keys': {
    if (env['LICENSE_SIGNING_PRIVATE_KEY'] && !args.includes('--new')) {
      console.log('· The license key pair is already in the file (--new makes another, which signs every installed copy out).');
      break;
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const line = (pem: string | Buffer) => Buffer.from(pem).toString('base64');
    const pub = line(publicKey.export({ type: 'spki', format: 'pem' }));
    write({ ...Object.fromEntries(Object.entries(DEFAULTS).filter(([key]) => !env[key])), LICENSE_SIGNING_PRIVATE_KEY: line(privateKey.export({ type: 'pkcs8', format: 'pem' })), MAIN_VITE_LICENSE_PUBLIC_KEY: pub });
    say(['Wrote LICENSE_SIGNING_PRIVATE_KEY (for Vercel) and MAIN_VITE_LICENSE_PUBLIC_KEY to the file.', 'Add MAIN_VITE_LICENSE_PUBLIC_KEY as a GitHub Actions variable (it is public):', pub]);
    break;
  }
  case 'stripe': {
    const stripe = new Stripe(need(env, 'STRIPE_SECRET_KEY'), { apiVersion: '2025-02-24.acacia' });
    const currency = args.find((arg) => arg.startsWith('--currency='))?.split('=')[1] ?? 'usd';
    const result = await setupStripe(stripe, { amounts: parseAmounts(args), currency, siteUrl: SITE });
    write(result.env);
    say([...result.notes, `Wrote ${Object.keys(result.env).join(', ')} to the file.`]);
    break;
  }
  case 'resend': {
    const result = await setupResend(fetch, { resendKey: need(env, 'RESEND_API_KEY'), domain: DOMAIN, vercelToken: env['VERCEL_TOKEN'], vercelTeamId: TEAM });
    say(result.notes);
    for (const record of result.records) console.log(`  ${record.type.padEnd(5)} ${record.name.padEnd(28)} ${record.value}`);
    break;
  }
  case 'supabase': {
    const result = await setupSupabaseAuth(fetch, { accessToken: need(env, 'SUPABASE_ACCESS_TOKEN'), projectRef: SUPABASE_REF, callbackUrl: `${SITE}/auth/callback`, siteUrl: SITE });
    say(result.notes);
    break;
  }
  case 'vercel': {
    const missing = missingVariables({ ...DEFAULTS, ...env });
    if (missing.length) console.log(`· Not yet in the file (upload continues without them): ${missing.join(', ')}`);
    const result = await setupVercel(fetch, { token: need(env, 'VERCEL_TOKEN'), teamId: TEAM, projectName: 'vc-dit', repo: 'kshank999-wq/VC-DIT', domain: DOMAIN, env: { ...DEFAULTS, ...env } });
    say([...result.notes, 'Vercel deploys on the next push to the production branch, or Deployments → Redeploy now.']);
    break;
  }
  case 'check': {
    const missing = missingVariables({ ...DEFAULTS, ...env });
    say(missing.length ? [`Still missing: ${missing.join(', ')}`] : ['Every variable vc-dit.com needs is in the file.']);
    break;
  }
  default:
    console.log('Steps: keys, stripe, resend, supabase, vercel, check. See the top of scripts/setup.ts.');
}
