import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { canDownload, loadAccount } from '@/lib/account';
import { DEVICES_PER_LICENSE, PLANS } from '@/lib/plans';
import { adminClient, currentUser } from '@/lib/supabase';
import { BillingButton, Devices, Downloads, ResendLicense, SignOut } from './widgets';

export const metadata: Metadata = { title: 'Account' };
export const dynamic = 'force-dynamic';

const date = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';

export default async function AccountPage() {
  const user = await currentUser();
  if (!user) redirect('/signin?next=/account');
  const subscriptions = await loadAccount(adminClient(), user.id);
  const current = subscriptions.find((sub) => sub.license?.status === 'active') ?? subscriptions[0] ?? null;

  return (
    <>
      <div className="hero">
        <div className="eyebrow">Account</div>
        <h1>Your VC DIT</h1>
        <p className="muted">
          Signed in as {user.email} · <SignOut />
        </p>
      </div>

      {!current ? (
        <div className="panel">
          <h2>No subscription yet</h2>
          <p className="muted">Subscribe to download the app and activate it on {DEVICES_PER_LICENSE} computers.</p>
          <div className="actions">
            <Link className="button" href="/pricing">
              See pricing
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid two">
          <div className="panel">
            <h2>{PLANS[current.plan].name}</h2>
            <dl className="kv">
              <dt>Status</dt>
              <dd>
                <span className={`badge ${current.license?.status === 'active' ? 'active' : 'ended'}`}>
                  {current.license?.status === 'active' ? (current.status === 'past_due' ? 'Active · payment due' : 'Active') : 'Ended'}
                </span>
              </dd>
              <dt>Billing</dt>
              <dd>{current.interval === 'year' ? 'Yearly' : 'Monthly'}</dd>
              <dt>{current.cancelAtPeriodEnd || current.license?.status !== 'active' ? 'Ends' : 'Renews'}</dt>
              <dd>{date(current.currentPeriodEnd)}</dd>
              <dt>Computers</dt>
              <dd>Up to {current.license?.maxActivations ?? DEVICES_PER_LICENSE}</dd>
            </dl>
            {current.license ? (
              <>
                <p className="muted" style={{ marginTop: 16, marginBottom: 4 }}>
                  Authorization code · keep it private
                </p>
                <p className="serial">{current.license.serial}</p>
                <ResendLicense />
              </>
            ) : (
              <p className="notice">Your authorization code is being issued; refresh in a moment.</p>
            )}
            <div className="actions">
              <BillingButton />
            </div>
          </div>
          <div className="panel">
            <h2>Download</h2>
            {canDownload(subscriptions) ? (
              <>
                <p className="muted">Install it, open it, and enter your authorization code to activate this computer.</p>
                <Downloads />
              </>
            ) : (
              <p className="muted">Downloads come with an active subscription.</p>
            )}
          </div>
        </div>
      )}

      {current ? (
        <section>
          <div className="panel">
            <h2>Computers</h2>
            <p className="muted">
              Each subscription runs on {DEVICES_PER_LICENSE} computers. Lost one, or replacing a cart? Free its seat here and
              activate the new one with your code.
            </p>
            <Devices />
          </div>
        </section>
      ) : null}
    </>
  );
}
