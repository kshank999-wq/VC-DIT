import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Thank you' };

/**
 * Where Stripe returns after a subscription checkout. The authorization code
 * is issued by the webhook, usually before this page loads, and emailed; the
 * account page shows it either way.
 */
export default function PurchaseComplete() {
  return (
    <div className="hero">
      <div className="eyebrow">Subscribed</div>
      <h1>Thank you</h1>
      <p className="lede">
        Your authorization code is on its way to your inbox, and on your account page now. Enter it on the download page to get
        the installer, then in the app to activate it.
      </p>
      <div className="actions">
        <Link className="button" href="/account">
          Go to your account
        </Link>
        <Link className="button secondary" href="/download">
          Download
        </Link>
      </div>
    </div>
  );
}
