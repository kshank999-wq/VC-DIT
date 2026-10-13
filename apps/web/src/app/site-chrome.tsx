import Link from 'next/link';

/** A placeholder mark (a verified check in a frame) until the brand arrives with the UI mockup. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="3" y="6" width="26" height="20" rx="2" fill="none" stroke="#c9a45c" strokeWidth="2" />
      <path d="M10 16 L14.5 20.5 L22.5 11.5" fill="none" stroke="#e8c872" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="wrap">
        <Link href="/" className="wordmark" aria-label="VC DIT home">
          <Mark />
          <span>
            VC <b>DIT</b>
          </span>
        </Link>
        <nav className="site-nav" aria-label="Site">
          <Link href="/#features">Features</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/download">Download</Link>
          <Link href="/account">Account</Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <span>© {new Date().getFullYear()} VC DIT · a VC product</span>
        <span>
          <Link href="/download">Download</Link> · <Link href="/pricing">Pricing</Link> · <Link href="/account">Account</Link>
        </span>
      </div>
    </footer>
  );
}
