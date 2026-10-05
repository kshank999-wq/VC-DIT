import type { Metadata } from 'next';
import { env, SITE_NAME } from '@/lib/env';
import { SiteFooter, SiteHeader } from './site-chrome';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(env.siteUrl),
  title: { default: `${SITE_NAME} — on-set workflow for DITs`, template: `%s · ${SITE_NAME}` },
  description:
    'Checksum-verified ingest, scene and setup organization, sync, dailies and looks, VFX mirroring and multi-destination delivery for Digital Imaging Technicians. For Mac and Windows.',
  openGraph: { title: SITE_NAME, description: 'Card to cut, verified. For Mac and Windows.', url: env.siteUrl, siteName: SITE_NAME },
};

/**
 * Every page renders per request, as VC Writer's do: the content security
 * policy carries a fresh nonce per response (middleware.ts), and a page
 * prerendered at build time has scripts without it, which `strict-dynamic`
 * then refuses.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteHeader />
        <main>
          <div className="wrap">{children}</div>
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
