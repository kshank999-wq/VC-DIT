import type { SupabaseClient } from '@supabase/supabase-js';
import type { Interval, Plan } from './env';
import type { LicenseStatus } from './plans';

/** What the account page shows: each subscription with its license. */
export interface AccountSubscription {
  id: string;
  stripeCustomerId: string;
  plan: Plan;
  interval: Interval;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  license: { serial: string; status: LicenseStatus; maxActivations: number } | null;
}

export const loadAccount = async (client: SupabaseClient, userId: string): Promise<AccountSubscription[]> => {
  const { data: subs } = await client
    .from('dit_subscriptions')
    .select('id, stripe_customer_id, plan, billing_interval, status, current_period_end, cancel_at_period_end, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  const { data: licenses } = await client
    .from('dit_licenses')
    .select('subscription_id, serial, status, max_activations')
    .eq('user_id', userId);
  return (subs ?? []).map((sub) => {
    const license = (licenses ?? []).find((candidate) => candidate.subscription_id === sub.id);
    return {
      id: sub.id as string,
      stripeCustomerId: sub.stripe_customer_id as string,
      plan: sub.plan as Plan,
      interval: sub.billing_interval as Interval,
      status: sub.status as string,
      currentPeriodEnd: (sub.current_period_end as string | null) ?? null,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
      license: license
        ? { serial: license.serial as string, status: license.status as LicenseStatus, maxActivations: license.max_activations as number }
        : null,
    };
  });
};

/** Whether the account may download the installers: an active license on any plan. */
export const canDownload = (subs: readonly AccountSubscription[]): boolean =>
  subs.some((sub) => sub.license?.status === 'active');
