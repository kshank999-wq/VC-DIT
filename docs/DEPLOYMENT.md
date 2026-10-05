# Selling VC DIT: deployment and service wiring

VC DIT is sold the way VC Game Studio is: **vc-dit.com** sells a
subscription and issues an **authorization code**. With the code, customers
download the desktop app for Mac or Windows and activate it on up to two
computers. Media never touches the website.

| Piece | Where | What it is |
| --- | --- | --- |
| Website | `apps/web` (Next.js on Vercel) | Home, pricing, sign-in, account (code, computers, billing), downloads, and the API the app calls |
| Desktop app | `apps/desktop` (Electron) | Activates with the authorization code and checks its license (`src/main/licensing.ts`) |
| Accounts and records | Supabase project **VCWriter** (`kpviyoqhmzignjyvixws`), shared with VC Writer and VC Game Studio | One VC account for every product. The tables are VC DIT's own, named `dit_*` (`supabase/migrations/dit_0001_commerce.sql`, **not yet applied**) |
| Payments | The Stripe account VC Writer and VC Game Studio use | One product, VC DIT: **$9.99 / month** or **$99 / year** |
| Email | Resend | The authorization code email |

## How a sale works

1. Pricing → **Subscribe monthly** or **yearly**. The customer signs in
   first with an emailed link (one VC account, so a VC Writer or VC Game
   Studio customer uses the same one). Checkout is Stripe's hosted page in
   subscription mode, tagged `metadata.product = vc-dit`.
2. Stripe's `customer.subscription.created` reaches `/api/stripe/webhook`. It
   records the subscription in `dit_subscriptions` and issues one license in
   `dit_licenses` with an authorization code (`VCDIT-XXXXX-XXXXX-XXXXX-XXXXX`,
   2 computers), and emails the code. Later events keep the license in step:
   - monthly ↔ yearly follows the subscription;
   - the license stays active while Stripe retries a card (`past_due`);
   - it expires when the subscription ends;
   - a refund or dispute revokes it.
3. **Download with the code.** On `/download` the customer enters the code
   and picks Mac or Windows; no sign-in is needed, because the DIT cart may
   not be a machine anyone reads email on. Each download is a 15-minute
   signed link from the private `dit-releases` bucket. A signed-in
   subscriber also gets plain download buttons on their account page.
4. **Activate with the code.** In the app, they enter the same code. The
   computer takes one of the two seats, and the site returns a signed
   entitlement (Ed25519). The app keeps it, checks in at start and every 6
   hours, and works offline for 14 days on the last one it got.
   - **Not activated, or lapsed:** the app opens, and productions, logs,
     reports and manifests can be read and exported, but no new ingest or
     delivery starts.
   - **A transfer already running always finishes and verifies.** Licensing
     never interrupts a copy of camera originals.
5. A lost or replaced cart: **Free this seat** on the account page, then
   activate the new computer. The app can also free its own seat
   (**Deactivate this computer**).

The code is a credential here (Game Studio's serial is not; it needs a
sign-in too). That is why it is 100 random bits, why every route that
accepts it is rate limited per address (`dit-activate`, `dit-status`,
`dit-download` in `apps/web/src/lib/rate-limit.ts`), and why it is only ever
shown to its owner.

## Before the first sale: VC Writer's webhook

Stripe sends every event in an account to every webhook endpoint. **VC
Writer's** webhook (`kshank999-wq/VCWriter`,
`apps/web/src/app/api/stripe/webhook/route.ts`) fulfills *every* paid
`checkout.session.completed` as a VC Writer purchase, so as it stands **each
VC DIT checkout would also issue a VC Writer license and email it**. The same
is true for VC Game Studio; its fix is in
`kshank999-wq/vc_game_studio/docs/commerce/vcwriter-stripe-scope.patch` and
has not been applied to VC Writer yet.

The fix: VC Writer's webhook should skip checkout sessions whose
`metadata.product` is another product's (`vc-game-studio`, `vc-dit`), or
better, fulfill only sessions it tagged itself. Deploy that to vc-writer.com
before the first VC DIT sale. (VC Game Studio's webhook already ignores VC
DIT's events, and VC DIT's ignores everyone else's.)

## Setting it up: six commands

Each step is one command, safe to run again, all sharing one git-ignored file,
`apps/web/.env.production.local`. Run them on your own computer, from the
repository root, after `npm install`.

1. **Start the file** with the keys only you hold:

   ```bash
   cp apps/web/.env.example apps/web/.env.production.local
   ```

   Fill in `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `STRIPE_SECRET_KEY` and `RESEND_API_KEY` (the same values VC Game
   Studio's Vercel project uses), and the two personal tokens used only by
   these steps and never uploaded: `VERCEL_TOKEN` and `SUPABASE_ACCESS_TOKEN`.
2. `npm run setup -w @vcdit/web -- keys` makes the license key pair and
   prints the public half for GitHub.
3. `npm run setup -w @vcdit/web -- stripe --monthly=9.99 --yearly=99` makes:
   - the VC DIT product and its two prices;
   - the webhook (its secret goes into the file);
   - **a customer portal of VC DIT's own** (not the account default, which
     VC Writer's Writers Room uses).
4. `npm run setup -w @vcdit/web -- resend` adds vc-dit.com to Resend, puts
   its DNS records in Vercel and asks Resend to verify it.
5. `npm run setup -w @vcdit/web -- supabase` adds
   `https://vc-dit.com/auth/callback` to the shared project's sign-in redirect
   list, keeping the other products' entries.
6. `npm run setup -w @vcdit/web -- vercel` creates the `vc-dit` Vercel
   project (linked to `kshank999-wq/VC-DIT`, root `apps/web`), attaches
   vc-dit.com and www, and uploads every variable (secrets as write-only).

`npm run setup -w @vcdit/web -- check` lists anything still missing.

## Supabase (the shared VCWriter project)

- **Database:** apply `supabase/migrations/dit_0001_commerce.sql`. It only
  adds `dit_*` tables, two enums and the `dit-releases` bucket; nothing of
  VC Writer's or VC Game Studio's is altered. It relies on what VC Writer
  already has there: `profiles`, the `platform`, `license_status` and
  `release_channel` enums, `touch_updated_at()`, `email_events` and the
  `consume_rate_limit` function.
- **Auth → URL configuration → Redirect URLs:** add
  `https://vc-dit.com/auth/callback` (step 5 does it).

## Vercel: environment variables

| Variable | Value | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://kpviyoqhmzignjyvixws.supabase.co` | Shared. Public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → VCWriter → API Keys → `sb_publishable_…` | Shared. Public |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → VCWriter → API Keys → `sb_secret_…` | Shared. **Secret** |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys | Shared. **Secret** |
| `STRIPE_WEBHOOK_SECRET` | The vc-dit.com endpoint's signing secret | **New. Secret** |
| `STRIPE_PRICE_MONTHLY` | `price_…` ($9.99 / month) | New, from step 3 |
| `STRIPE_PRICE_YEARLY` | `price_…` ($99 / year) | New, from step 3 |
| `STRIPE_PORTAL_CONFIGURATION` | `bpc_…`, from step 3 | VC DIT's own customer portal |
| `RESEND_API_KEY` | Resend → API keys | **Secret** |
| `RESEND_FROM_ADDRESS` | `VC DIT <noreply@vc-dit.com>` | Needs vc-dit.com verified in Resend |
| `LICENSE_SIGNING_PRIVATE_KEY` | From step 2 | **Secret.** Signs what the app may do |
| `NEXT_PUBLIC_SITE_URL` | `https://vc-dit.com` | |
| `STRIPE_AUTOMATIC_TAX` | `1` once Stripe Tax is active | Optional |
| `RELEASE_BUCKET` | `dit-releases` | Optional; the default |
| `RATE_LIMIT_SALT` | Any random string | Optional |
| `ELECTRON_SKIP_BINARY_DOWNLOAD` | `1` | The site never uses Electron |

## Stripe webhook events

`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`
at `https://vc-dit.com/api/stripe/webhook` (step 3 does it). Redelivery is
safe: event ids are claimed in `dit_stripe_webhook_events`, and there is one
license per subscription. To test locally:
`stripe listen --forward-to localhost:3000/api/stripe/webhook`.

## GitHub: building the installers

`.github/workflows/desktop-release.yml` runs on a `v*` tag. It builds the
Windows installer and the macOS universal DMG, uploads them as workflow
artifacts, and, after approval in the `release` environment, publishes them
(`apps/web/scripts/publish-release.mjs`).

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `MAIN_VITE_SITE_URL` | `https://vc-dit.com` |
| Variable | `MAIN_VITE_LICENSE_PUBLIC_KEY` | The public key from step 2 |
| Variable | `SUPABASE_URL` | `https://kpviyoqhmzignjyvixws.supabase.co` (the publish job) |
| Secret | `SUPABASE_SERVICE_ROLE_KEY` | For the publish job |
| Secret | `CSC_LINK`, `CSC_KEY_PASSWORD` | Apple Developer ID Application certificate (.p12, base64) and its password |
| Secret | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization |
| Secret | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` | Windows signing via Azure Artifact Signing (**pending**) |

The workflow refuses to package without `MAIN_VITE_LICENSE_PUBLIC_KEY`,
because a build without it has licensing switched off. **macOS** can be
signed and notarized now with the Apple certificate. **Windows** builds
unsigned until Azure Artifact Signing is approved; SmartScreen warns on an
unsigned installer, so do not publish one to customers. Add the `release`
environment (Settings → Environments) with yourself as a required reviewer.

## Local development

- `npm run dev -w @vcdit/web`: the site, with the variables above in
  `apps/web/.env.local`.
- `npm run dev -w @vcdit/desktop`: the app. Without
  `MAIN_VITE_LICENSE_PUBLIC_KEY` it is a developer build with licensing off.
