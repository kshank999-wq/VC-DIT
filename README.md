# VC DIT

On-set workflow platform for Digital Imaging Technicians: verified camera and sound ingest, automated scene / setup organization, sync, dailies and look management, VFX mirroring, and multi-destination delivery (drives, NAS, LucidLink-style volumes, Frame.io, Google Drive).

Website: [www.vc-dit.com](https://www.vc-dit.com)

## Documents

- [Development Specification v1](docs/SPEC_v1.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Deployment and selling](docs/DEPLOYMENT.md)

## How it is sold

A subscription, **$9.99 / month or $99 / year**, for Mac and Windows. Checkout emails an **authorization code**; the customer enters it on vc-dit.com/download to get the installer, then in the app to activate it. Each subscription runs on **two computers**.

## The repository

Same tools as VC Game Studio and VC Writer.

| Path | What | Stack |
| --- | --- | --- |
| `apps/desktop` | The VC DIT app | Electron 33, React 18, TypeScript, electron-vite, electron-builder |
| `apps/web` | vc-dit.com: pricing, checkout, account, downloads, licensing API | Next.js 14 on Vercel |
| `supabase/migrations` | `dit_*` tables in the shared VC Supabase project | Postgres |

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

The commerce and licensing layer is ported from VC Game Studio and tested. The desktop app is a shell listing the spec's screens; they are built from the UI mockup when it is handed off.
