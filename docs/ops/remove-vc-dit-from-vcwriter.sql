-- One-off cleanup for the VCWriter Supabase project (kpviyoqhmzignjyvixws).
-- VC DIT briefly had its (always empty) tables there on 5 Oct 2026 before it
-- moved to its own project. This removes them. Nothing of VC Writer's or
-- VC Game Studio's is touched. Run in Supabase → VCWriter → SQL editor.
drop table if exists public.dit_device_activations;
drop table if exists public.dit_licenses;
drop table if exists public.dit_subscriptions;
drop table if exists public.dit_release_builds;
drop table if exists public.dit_stripe_webhook_events;
drop type if exists public.dit_plan;
drop type if exists public.dit_interval;
-- The empty installer bucket: Storage → dit-releases → Delete bucket
-- (the dashboard does this; SQL on storage tables is blocked).
