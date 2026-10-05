-- VC DIT: the whole database, in its own Supabase project (vc-dit). Nothing
-- here is shared with VC Writer or VC Game Studio: own accounts, own
-- commerce, own installers.
--
-- Entitlement is server-authoritative: subscriptions, licenses, seats and
-- releases are written only by the service role (the Stripe webhook and the
-- licensing routes). A customer can read their own rows and write none.

-- ---------------------------------------------------------------------------
-- Shared plumbing
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- An account: auth.users holds the credentials, this the application record.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  -- Mirror of auth.users.email, so the webhook can find a returning customer in one indexed query.
  email text,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index profiles_email_key on public.profiles (lower(email)) where email is not null;

create trigger profiles_touch_updated_at before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Every new account gets its profile from the auth trigger, never from client code.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''), new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep the mirror right when someone changes their address.
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

revoke execute on function public.handle_user_email_change() from public, anon, authenticated;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function public.handle_user_email_change();

-- Transactional email outcomes (template@version, Resend's id, success or why not).
create table public.email_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete set null,
  template text not null,
  provider_message_id text,
  status text not null default 'queued',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index email_events_user_idx on public.email_events (user_id);

create trigger email_events_touch_updated_at before update on public.email_events
  for each row execute function public.touch_updated_at();

-- Per-address rate limiting for the public routes (activation, downloads,
-- checkout). Keys are `<rule>:<hashed address>`, never a raw address.
create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

-- Count one hit against a fixed window and say whether it was within the
-- limit. Atomic: two requests racing for the last slot cannot both get a yes.
create or replace function public.consume_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into public.rate_limits (key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set count = public.rate_limits.count + 1
  returning public.rate_limits.count into v_count;

  -- Sweep old windows once per window, not once per request.
  if v_count = 1 then
    delete from public.rate_limits where window_start < now() - make_interval(secs => p_window_seconds * 2);
  end if;

  return query
  select
    v_count <= p_limit,
    greatest(p_limit - v_count, 0),
    case
      when v_count <= p_limit then 0
      else greatest(1, ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds) - now())))::integer)
    end;
end;
$$;

-- Service role only: nobody may spend or read someone else's allowance.
revoke execute on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Commerce
-- ---------------------------------------------------------------------------

create type public.platform as enum ('windows', 'macos');
create type public.license_status as enum ('active', 'suspended', 'revoked', 'expired');
create type public.release_channel as enum ('stable', 'beta', 'internal');
-- One plan today; an enum so a second (VC VFX Prep) is an ALTER TYPE.
create type public.plan as enum ('dit');
create type public.billing_interval as enum ('month', 'year');

-- One row per Stripe subscription, written from Stripe's own events.
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete restrict,
  stripe_subscription_id text not null unique,
  stripe_customer_id text not null,
  stripe_price_id text not null,
  plan public.plan not null,
  billing_interval public.billing_interval not null,
  -- Stripe's status, verbatim: active, trialing, past_due, canceled, unpaid…
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index subscriptions_user_idx on public.subscriptions (user_id);
create index subscriptions_customer_idx on public.subscriptions (stripe_customer_id);

-- One license per subscription: the unique subscription_id makes a retried
-- webhook idempotent. `serial` is the customer's authorization code
-- (VCDIT-XXXXX-…). It is a credential, used without sign-in to download the
-- installer and activate a computer, so it is only ever shown to its owner.
create table public.licenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete restrict,
  subscription_id uuid not null unique references public.subscriptions (id) on delete restrict,
  serial text not null unique,
  plan public.plan not null,
  -- Active while paid up (or in Stripe's retry window), expired once it ends, revoked on a refund or dispute.
  status public.license_status not null default 'active',
  entitled_platforms public.platform[] not null default array['windows', 'macos']::public.platform[],
  max_activations integer not null default 2 check (max_activations > 0),
  paid_through timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index licenses_user_idx on public.licenses (user_id);

create table public.device_activations (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.licenses (id) on delete cascade,
  device_fingerprint text not null,
  device_name text not null default '',
  platform public.platform not null,
  app_version text not null default '',
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  -- Freeing a seat is bookkeeping, not a delete, so support can see history.
  deactivated_at timestamptz,
  constraint device_activations_unique unique (license_id, device_fingerprint)
);

create index device_activations_license_idx on public.device_activations (license_id) where deactivated_at is null;

-- Windows and macOS installers are published independently.
create table public.release_builds (
  id uuid primary key default gen_random_uuid(),
  platform public.platform not null,
  version text not null,
  channel public.release_channel not null default 'stable',
  minimum_os_version text not null default '',
  -- Storage object key in the releases bucket, never a public URL.
  artifact_key text not null,
  artifact_size_bytes bigint not null default 0,
  sha256 text not null default '',
  release_notes text not null default '',
  active boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint release_builds_version_unique unique (platform, channel, version)
);

create unique index release_builds_active_idx on public.release_builds (platform, channel) where active;

-- The webhook claims Stripe event ids here, so a redelivery is handled once.
create table public.stripe_webhook_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

create trigger subscriptions_touch_updated_at before update on public.subscriptions
  for each row execute function public.touch_updated_at();
create trigger licenses_touch_updated_at before update on public.licenses
  for each row execute function public.touch_updated_at();
create trigger release_builds_touch_updated_at before update on public.release_builds
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.email_events enable row level security;
alter table public.rate_limits enable row level security;
alter table public.subscriptions enable row level security;
alter table public.licenses enable row level security;
alter table public.device_activations enable row level security;
alter table public.release_builds enable row level security;
alter table public.stripe_webhook_events enable row level security;

create policy "customers read their own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "customers update their own profile" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "customers read their own subscriptions" on public.subscriptions
  for select to authenticated using (user_id = (select auth.uid()));

create policy "customers read their own licenses" on public.licenses
  for select to authenticated using (user_id = (select auth.uid()));

create policy "customers read their own activations" on public.device_activations
  for select to authenticated using (
    exists (select 1 from public.licenses l where l.id = license_id and l.user_id = (select auth.uid()))
  );

create policy "signed-in users read active stable builds" on public.release_builds
  for select to authenticated using (active and channel = 'stable');

-- email_events, rate_limits and stripe_webhook_events have no policies: service role only.

-- The private bucket the installers live in; downloads are short-lived signed URLs.
insert into storage.buckets (id, name, public)
values ('releases', 'releases', false)
on conflict (id) do nothing;
