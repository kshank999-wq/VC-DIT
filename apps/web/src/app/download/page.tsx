import type { Metadata } from 'next';
import Link from 'next/link';
import { canDownload, loadAccount } from '@/lib/account';
import { adminClient, currentUser } from '@/lib/supabase';
import { CodeDownload, Downloads } from '../account/widgets';

export const metadata: Metadata = { title: 'Download' };
export const dynamic = 'force-dynamic';

interface Release {
  platform: 'windows' | 'macos';
  version: string;
  minimum_os_version: string;
}

const readReleases = async (): Promise<Release[]> => {
  try {
    const { data } = await adminClient()
      .from('dit_release_builds')
      .select('platform, version, minimum_os_version')
      .eq('channel', 'stable')
      .eq('active', true);
    return (data ?? []) as Release[];
  } catch {
    // No database configured (a preview deployment, CI): the page still renders.
    return [];
  }
};

/**
 * The installers. Anyone with the authorization code from their purchase email
 * can download, without signing in (the cart may have no email on it); a
 * signed-in subscriber also gets plain buttons.
 */
export default async function DownloadPage() {
  const user = await currentUser().catch(() => null);
  const subscriptions = user ? await loadAccount(adminClient(), user.id).catch(() => []) : [];
  const releases = await readReleases();
  const line = (platform: Release['platform'], label: string) => {
    const release = releases.find((candidate) => candidate.platform === platform);
    return release ? `${label} ${release.version}${release.minimum_os_version ? ` · ${release.minimum_os_version} or later` : ''}` : null;
  };

  return (
    <>
      <div className="hero">
        <div className="eyebrow">Download</div>
        <h1>Get VC DIT</h1>
        <p className="lede">
          For macOS and Windows 10 / 11. Enter the authorization code from your purchase email, install, and enter the same code
          in the app to activate this computer.
        </p>
      </div>
      <div className="panel" style={{ maxWidth: 640 }}>
        {user && canDownload(subscriptions) ? <Downloads /> : <CodeDownload />}
        <p className="muted" style={{ marginTop: 12 }}>
          {[line('macos', 'Mac'), line('windows', 'Windows')].filter(Boolean).join(' · ') || 'The first builds are on their way.'}
        </p>
        {!user ? (
          <p className="muted">
            No code yet? <Link href="/pricing">Subscribe</Link>. Lost it? <Link href="/signin?next=/account">Sign in</Link> and it is
            on your account page.
          </p>
        ) : null}
      </div>
    </>
  );
}
