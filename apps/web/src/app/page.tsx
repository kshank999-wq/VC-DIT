import Link from 'next/link';
import { DEVICES_PER_LICENSE } from '@/lib/plans';

export const dynamic = 'force-dynamic';

const FEATURES: { title: string; body: string; accent: string }[] = [
  {
    title: 'Verified ingest, many destinations',
    body: 'Camera cards and sound media are detected as they mount. One copy writes to every destination at once, checksummed, and a card is only marked safe to format once every copy verifies.',
    accent: 'var(--green)',
  },
  {
    title: 'Organized by the script supervisor',
    body: 'Import the day’s log and VC DIT builds scene and setup folders, matches clips to takes, and flags circle takes, without ever dropping a non-select.',
    accent: 'var(--gold)',
  },
  {
    title: 'Picture and sound in sync',
    body: 'Batch sync by timecode, with waveform fallback and manual offsets for the exceptions. Originals stay untouched; sync is a relationship, not a re-render.',
    accent: 'var(--c-object)',
  },
  {
    title: 'The production’s look, on the dailies',
    body: 'Import the show LUTs, assign them by camera, day, scene or clip, and apply them to dailies and proxies. Camera originals are never baked.',
    accent: 'var(--c-puzzle)',
  },
  {
    title: 'VFX shots, mirrored',
    body: 'A take flagged VFX stays in its editorial scene and setup, and also appears under VFX → Scene → Setup, with the script supervisor’s notes, ready for VC VFX Prep.',
    accent: 'var(--c-scene)',
  },
  {
    title: 'Delivery with a manifest',
    body: 'Hand off to drives, NAS, LucidLink-style shared volumes, Frame.io and cloud storage, each verified, each recorded in a manifest of what went where.',
    accent: 'var(--gold-hi)',
  },
];

export default function Home() {
  return (
    <>
      <div className="hero">
        <div className="eyebrow">For Mac and Windows</div>
        <h1>
          Card to cut, <span>verified.</span>
        </h1>
        <p className="lede">
          VC DIT is the on-set workflow for Digital Imaging Technicians: checksum-verified ingest, automatic scene and setup
          organization, sync, dailies and looks, VFX mirroring and multi-destination delivery. A production traffic-control
          system, not a file copier.
        </p>
        <div className="actions">
          <Link className="button" href="/pricing">
            Subscribe
          </Link>
          <Link className="button secondary" href="/download">
            Download with your code
          </Link>
        </div>
      </div>

      <section id="features">
        <h2>What it does</h2>
        <div className="grid three">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="panel feature" style={{ ['--accent' as string]: feature.accent }}>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="panel grid two" style={{ alignItems: 'center' }}>
          <div>
            <h2>One subscription, two computers</h2>
            <p className="muted">
              Monthly or yearly. Each subscription activates on {DEVICES_PER_LICENSE} computers, Mac or Windows: the cart and a
              second station. Already a VC Writer or VC Game Studio customer? It is the same account.
            </p>
          </div>
          <div className="actions" style={{ justifyContent: 'flex-end' }}>
            <Link className="button" href="/pricing">
              Pricing
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
