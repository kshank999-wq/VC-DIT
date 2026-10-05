-- VC DIT commerce: subscriptions, licenses, device seats and installer
-- releases, in the Supabase project VC Writer already runs (project VCWriter,
-- kpviyoqhmzignjyvixws).
--
-- Shared accounts: a customer is one row of public.profiles, the same row VC
-- Writer and VC Game Studio use, so one sign-in covers every VC product. Everything else is
-- VC DIT's own and carries the dit_ prefix; nothing of VC Writer's is
-- altered. Its enums (platform, license_status, release_channel) and its
-- touch_updated_at() trigger function are reused as they are.
--
-- Entitlement is server-authoritative, as in VC Writer: rows here are written
-- only by the service role, from the Stripe webhook and the licensing routes,
-- and a customer can read their own and write none.

-- One plan today ('dit'); an enum so a second (VC VFX Prep) is an ALTER TYPE.
create type public.dit_plan as enum ('dit');
create type public.dit_interval as enum ('month', 'year');

-- One row per Stripe subscription, written from Stripe's own events.
create table public.dit_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete restrict,
  stripe_subscription_id text not null unique,
  stripe_customer_id text not null,
  stripe_price_id text not null,
  plan public.dit_plan not null,
  billing_interval public.dit_interval not null,
  -- Stripe's status, verbatim: active, trialing, past_due, canceled, unpaid…
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index dit_subscriptions_user_idx on public.dit_subscriptions (user_id);
create index dit_subscriptions_customer_idx on public.dit_subscriptions (stripe_customer_id);

-- One license per subscription. The unique subscription_id is what makes a
-- retried webhook idempotent: however often Stripe redelivers, one license.
-- `serial` is the customer's authorization code (VCDIT-XXXXX-…): unlike VC Game
-- Studio's serial it is a credential, used without sign-in to download the
-- installer and activate a computer, so it is only ever shown to its owner.
create table public.dit_licenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete restrict,
  subscription_id uuid not null unique references public.dit_subscriptions (id) on delete restrict,
  serial text not null unique,
  plan public.dit_plan not null,
  -- Follows the subscription: active while it is paid up (or in Stripe's
  -- retry window), expired once it ends, revoked on a refund or dispute.
  status public.license_status not null default 'active',
  entitled_platforms public.platform[] not null default array['windows', 'macos']::public.platform[],
  max_activations integer not null default 2 check (max_activations > 0),
  -- The end of the period paid for; the desktop app works offline until then
  -- (plus its grace), so a lapse is noticed at renewal, not mid-session.
  paid_through timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index dit_licenses_user_idx on public.dit_licenses (user_id);

create table public.dit_device_activations (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.dit_licenses (id) on delete cascade,
  device_fingerprint text not null,
  device_name text not null default '',
  platform public.platform not null,
  app_version text not null default '',
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  -- Freeing a seat is bookkeeping, not a delete, so support can see history.
  deactivated_at timestamptz,
  constraint dit_device_activations_unique unique (license_id, device_fingerprint)
);

create index dit_device_activations_license_idx on public.dit_device_activations (license_id) where deactivated_at is null;

-- Windows and macOS installers are published independently.
create table public.dit_release_builds (
  id uuid primary key default gen_random_uuid(),
  platform public.platform not null,
  version text not null,
  channel public.release_channel not null default 'stable',
  minimum_os_version text not null default '',
  -- Storage object key in the dit-releases bucket, never a public URL.
  artifact_key text not null,
  artifact_size_bytes bigint not null default 0,
  sha256 text not null default '',
  release_notes text not null default '',
  active boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dit_release_builds_version_unique unique (platform, channel, version)
);

create unique index dit_release_builds_active_idx on public.dit_release_builds (platform, channel) where active;

-- VC DIT's webhook endpoint claims event ids here. Its own table, not
-- VC Writer's: both endpoints receive every event of the shared Stripe
-- account, and each must be able to claim and skip independently.
create table public.dit_stripe_webhook_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

create trigger dit_subscriptions_touch_updated_at before update on public.dit_subscriptions
  for each row execute function public.touch_updated_at();
create trigger dit_licenses_touch_updated_at before update on public.dit_licenses
  for each row execute function public.touch_updated_at();
create trigger dit_release_builds_touch_updated_at before update on public.dit_release_builds
  for each row execute function public.touch_updated_at();

alter table public.dit_subscriptions enable row level security;
alter table public.dit_licenses enable row level security;
alter table public.dit_device_activations enable row level security;
alter table public.dit_release_builds enable row level security;
alter table public.dit_stripe_webhook_events enable row level security;

create policy "customers read their own VC DIT subscriptions" on public.dit_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));

create policy "customers read their own VC DIT licenses" on public.dit_licenses
  for select to authenticated using (user_id = (select auth.uid()));

create policy "customers read their own VC DIT activations" on public.dit_device_activations
  for select to authenticated using (
    exists (select 1 from public.dit_licenses l where l.id = license_id and l.user_id = (select auth.uid()))
  );

create policy "signed-in users read active stable VC DIT builds" on public.dit_release_builds
  for select to authenticated using (active and channel = 'stable');

-- dit_stripe_webhook_events has no policies: service role only.

-- The private bucket the installers live in; downloads are signed URLs.
insert into storage.buckets (id, name, public)
values ('dit-releases', 'dit-releases', false)
on conflict (id) do nothing;
