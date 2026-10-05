# VC DIT architecture

The tools match VC Game Studio and VC Writer (an npm workspace with an
Electron desktop app and a Next.js website on Vercel, with Supabase, Stripe
and Resend), but VC DIT runs entirely on its own services: its own Supabase
project, Stripe account, Resend domain and Vercel project. Product requirements are in
[SPEC_v1.md](SPEC_v1.md); selling and releasing are in
[DEPLOYMENT.md](DEPLOYMENT.md).

```
apps/
  desktop/   Electron app (TypeScript, React, electron-vite, electron-builder)
    src/main/       main process: window, license, and (to come) the media engine
    src/preload/    the narrow bridge the renderer may call (window.vcdit)
    src/renderer/   React UI, built from docs/ui/HANDOFF.md
      model/          types (spec §6), the HALCYON demo day, status.ts (all derived status)
      state/          one reducer: AppState and every action
      shell/          header, flow bar, files panel, license dialog
      screens/        Today, Project setup and the six steps' screens
      ui/kit.tsx      shared pieces (status dot + word, pills, bars, license-gated StartButton)
      theme.css       the handoff's tokens, light and dark
  web/       vc-dit.com (Next.js 14): pricing, checkout, account, downloads,
             and the licensing API the app calls
supabase/migrations/   the whole schema of the vc-dit Supabase project
docs/                  spec, architecture, deployment
```

## Where things run

| Concern | Runs in | Why |
| --- | --- | --- |
| Accounts, subscription, authorization code, seats, installers | vc-dit.com + Supabase | The only part that needs a server |
| Volume detection, verified copy, checksums, sync, LUT/dailies render, manifests | Desktop main process and worker processes | It touches camera originals and needs the disks; it must work with no network |
| Production database (productions, shoot days, clips, takes, sync, looks, transfers, VFX) | A local database on the cart (SQLite), one per production, exportable | On set there is often no connection; the spec's "media index" lets one clip appear in editorial, selects and VFX views without three copies |
| Delivery to cloud destinations | Desktop, directly to the provider | Media goes from the cart to Frame.io or Drive, never through vc-dit.com |

The renderer never touches the filesystem. Every disk operation goes through
the main process over typed IPC in `src/preload/index.ts`, so the code paths
that can write near camera originals are few and testable.

## Licensing in one paragraph

Activation takes the authorization code from the purchase email; the computer
takes one of two seats; the site returns an Ed25519-signed entitlement the app
keeps and refreshes every 6 hours, valid 14 days offline. Unlicensed, the app
reads and exports but starts no new ingest or delivery; a running transfer
always finishes. Code: `apps/desktop/src/main/licensing.ts`,
`apps/web/src/lib/activation-service.ts`.

## Media integrity rules (spec §8), as engineering constraints

- **Originals are read-only.** The copy engine opens sources read-only; no
  code path renames, moves, or deletes on a volume classified Camera Source or
  Sound Source. Organization is done in destinations and in the index.
- **No "safe to format" without every required destination verified.** A
  destination is verified when its copy has been read back and its checksum
  matches the source's (xxHash64 by default for speed; MD5 and SHA-1
  selectable where a production requires them). The method is in every log.
- **Failure is loud.** A failed or partial verification can never show green.
- **Everything is a record.** Every transfer writes a manifest (source,
  destinations, files, sizes, checksums, method, times, retries) to the
  production's `REPORTS/ingest_verification/` and to the local database.

## Destinations

Ingest (§4.3) and delivery (§4.10) both write to a list of destinations at
once. A destination is an adapter behind one interface, so local drives,
network storage and cloud services are the same thing to the transfer engine:

```ts
interface Destination {
  kind: 'volume' | 'frameio' | 'gdrive' | 's3' /* … */;
  /** Free space, permissions, a connection: checked before a transfer starts (§4.10 preflight). */
  preflight(plan: TransferPlan): Promise<Preflight>;
  /** Write one file; resumable where the provider allows. Reports bytes as they go. */
  put(file: SourceFile, path: DestinationPath, progress: Progress): Promise<Written>;
  /** Prove what was written: read back and hash, or the provider's own checksum. */
  verify(written: Written): Promise<Verification>;
}
```

| Destination | How | Verification |
| --- | --- | --- |
| Local / removable drives, RAID, shuttle drives | Filesystem | Read back and re-hash |
| NAS / SMB / NFS shares | Filesystem (mounted) | Read back and re-hash |
| **LucidLink** and similar mounted cloud filesystems (Suite Studios, etc.) | Filesystem: the share is a mounted volume, so it is a `volume` destination. Upload to the cloud is LucidLink's own; VC DIT can show its cache-upload state where the client exposes it | Read back and re-hash through the mount |
| **Frame.io** (V4 API) | OAuth through Adobe IMS, as VC Film Studio connects (`kshank999-wq/VC_Film_Studio` `lib/frameio-*.ts`), but from the desktop app with PKCE and a loopback redirect, so tokens stay on the cart (OS keychain via Electron `safeStorage`) | Frame.io's reported file size and checksum after upload |
| **Google Drive** | OAuth (installed-app flow), resumable uploads, as VC Film Studio's Drive connector but writing files, not only folders | Drive's `md5Checksum` against the source's MD5 |
| Others later (Dropbox, Box, S3-compatible object storage, MASV) | Same interface | Provider checksum where offered, else size plus a read-back sample |

Two choices from VC Film Studio carry over: every provider call returns a
discriminated result (no `null` meaning "fine"), and a rate limit stops and
reports how far it got instead of retrying silently. One choice differs: Film
Studio's connectors are server-side with shared credentials. VC DIT's run on
the customer's machine with the customer's own Frame.io or Google account,
because the media is there and must not pass through vc-dit.com.

## What comes next

1. Done: the UI handoff is built as the renderer, on demo data. Status is
   derived in one place (`model/status.ts`), so the header, flow bar, file
   tree and Today never disagree, and nothing shows green while a copy failed.
2. The media engine in the main process: volume detection (macOS
   DiskArbitration events and Windows volume notifications), the
   multi-destination copy-and-verify engine in worker threads, and the local
   production database.
3. Script-supervisor import (CSV / JSON / XML neutral schema) and the match
   review screen.
4. Sync, LUT / dailies rendering (FFmpeg plus camera SDKs where raw formats
   need them), VFX mirroring, delivery packages and manifests.
5. Frame.io, then Google Drive, as destination adapters.
