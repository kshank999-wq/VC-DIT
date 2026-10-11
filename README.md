# VC DIT

On-set workflow platform for Digital Imaging Technicians: verified camera and sound ingest, automated scene / setup organization, sync, dailies and look management, VFX mirroring, and multi-destination delivery (drives, NAS, LucidLink-style volumes, Frame.io, Google Drive).

Website: [www.vc-dit.com](https://www.vc-dit.com)

## Documents

- [Development Specification v1](docs/SPEC_v1.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Deployment and selling](docs/DEPLOYMENT.md)
- [UI handoff](docs/ui/HANDOFF.md) (mockups in `docs/ui/mockups/`; open in a browser)

## How it is sold

A subscription, **$9.99 / month or $99 / year**, for Mac and Windows. Checkout emails an **authorization code**; the customer enters it on vc-dit.com/download to get the installer, then in the app to activate it. Each subscription runs on **two computers**.

## The repository

Same tools as VC Game Studio and VC Writer, on entirely separate services: VC DIT has its own Supabase project, Stripe account, Resend domain and Vercel project.

| Path | What | Stack |
| --- | --- | --- |
| `apps/desktop` | The VC DIT app | Electron 33, React 18, TypeScript, electron-vite, electron-builder |
| `apps/web` | vc-dit.com: pricing, checkout, account, downloads, licensing API | Next.js 14 on Vercel |
| `supabase/migrations` | The schema of VC DIT's own Supabase project | Postgres |

| Concern | Service |
| --- | --- |
| Website, account portal, APIs | Vercel |
| Auth, database, licensing, installer storage | Supabase |
| Subscriptions and billing | Stripe |
| Transactional email | Resend |
| macOS signing and notarization | Apple Developer ID |
| Windows signing | Azure Artifact Signing (pending) |

```bash
npm install
npm run typecheck
npm test
npm run dev -w @vcdit/desktop   # the app (licensing off without the public key)
npm run dev -w @vcdit/web       # the site
```

## Status

- Commerce and licensing: ported from VC Game Studio and tested. Its database goes in a Supabase project of its own (`supabase/migrations/0001_vc_dit_base.sql`).
- Desktop UI: every screen of the UI handoff (`docs/ui/`) built in React on the HALCYON demo day, light and dark. Run it in a browser with `npm run dev:renderer -w @vcdit/desktop`.
- Media engine, first part: real volume detection, the verified copy to several destinations at once (xxHash64 / MD5 / SHA-1), ASC MHL and transfer logs, behind Intake, Verify and Today in the desktop app (`apps/desktop/src/main/media`).
- Production database: one SQLite file per production (settings, shoot days, scene lists, transfers, every clip and its checksum), kept across restarts; new, open and save-a-copy in Project setup (`apps/desktop/src/main/db`).
- Script supervisor log: CSV, tab-separated, Avid ALE, JSON or XML, matched to the day's clips and sound; uncertain matches go to Match review (`apps/desktop/src/main/scriptlog`).
- VFX: flagged and tagged shots mirrored into VFX → Scene → Setup → Take (hard link, reference or verified copy), and handed to VC VFX Prep as a package (`apps/desktop/src/main/vfx`).
- Sync: timecode read from MOV/MP4, MXF and Broadcast WAV headers; picture paired with sound by timecode, checked against the scratch audio's waveform, with a waveform pass for clips without timecode (`apps/desktop/src/main/sync`).
- Looks and dailies: LUT library with assignment rules and a real look preview; dailies rendered with FFmpeg (look, burn-ins, synced sound, ProRes/DNxHR/H.264) into SYNCED_DAILIES with a checksummed manifest (`apps/desktop/src/main/dailies`). Packaging fetches a pinned FFmpeg (`apps/desktop/scripts/fetch-ffmpeg.mjs`).
- Delivery: packages (originals archive, editorial handoff with ALE, dailies, VFX, reports) to several drives or folders at once, with capacity preflight, verified copies, originals checked against their ingest checksums, ASC MHL and manifests on each destination, presets and per-file retry (`apps/desktop/src/main/delivery`).
- Scene folders: every verified clip linked under CAMERA_ORIGINALS/_BY_SCENE/SCENE/SETUP/<take>, circle takes under SELECTS_CIRCLE_TAKES, named by the production's editable naming template, following the log; originals untouched (`apps/desktop/src/main/organize`).
- Reports: every step's record for the day with its files on the drives, and a day report PDF saved or written to REPORTS/day_report on each drive (`apps/desktop/src/main/reports`).
- Next: Frame.io and Google Drive as delivery destinations.
