import type { Metadata } from 'next';
import { fetchDisplayPrices } from '@/lib/pricing';
import { DEVICES_PER_LICENSE, PLAN } from '@/lib/plans';
import { currentUser } from '@/lib/supabase';
import { PricingTiers } from './tiers';

export const metadata: Metadata = { title: 'Pricing' };
export const dynamic = 'force-dynamic';

export default async function PricingPage({ searchParams }: { searchParams: { cancelled?: string } }) {
  const prices = await fetchDisplayPrices();
  const user = await currentUser().catch(() => null);
  return (
    <>
      <div className="hero">
        <div className="eyebrow">Pricing</div>
        <h1>One plan, everything in it</h1>
        <p className="lede">
          The desktop app for Mac and Windows, on {DEVICES_PER_LICENSE} computers, with every update while you subscribe. Cancel any
          time from your account.
        </p>
        {searchParams.cancelled ? <p className="notice">Checkout was cancelled; nothing was charged.</p> : null}
      </div>
      <PricingTiers signedIn={Boolean(user)} name={PLAN.name} tagline={PLAN.tagline} features={PLAN.features} prices={prices ?? {}} />
      <section>
        <h2>Questions</h2>
        <div className="grid two">
          <div className="panel">
            <h3>How do I get the app?</h3>
            <p className="muted">
              After checkout you are emailed an authorization code. Enter it on the download page for the Mac or Windows
              installer, then once in the app to activate that computer.
            </p>
          </div>
          <div className="panel">
            <h3>Where is my media?</h3>
            <p className="muted">
              On your drives and destinations, where you send it. VC DIT never uploads anything you have not pointed it at.
            </p>
          </div>
          <div className="panel">
            <h3>Does it work offline?</h3>
            <p className="muted">
              Yes. Carts are often off the network: it checks your subscription when it can, and keeps working for 14 days
              without a connection.
            </p>
          </div>
          <div className="panel">
            <h3>What if my subscription ends?</h3>
            <p className="muted">
              Your media, logs and manifests are yours and stay where they are. A transfer already running always finishes; new
              ingests and deliveries pause until you subscribe again.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
