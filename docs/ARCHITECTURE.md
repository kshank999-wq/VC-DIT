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
    src/main/       main process: window, license, the production database (db/)
                    and the media engine (media/)
    src/shared/     types the engine and the screens share over IPC
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

## The media engine (`src/main/media`)

| File | Does |
| --- | --- |
| `volumes.ts` | Finds mounted volumes every 2 s (`/Volumes` on macOS, drive letters on Windows), describes each once (diskutil / CIM), and suggests a role from what is on it (ARRI, RED, Sony, Blackmagic, Canon, sound WAVs, a VC DIT drive, empty) |
| `transfer.ts` | The verified copy: reads the card once, hashes and writes every destination in the same pass, then reads each copy back and compares |
| `checksum.ts` | xxHash64 (WebAssembly), MD5, SHA-1, fed chunk by chunk |
| `reports.ts` | ASC MHL v2.0 generation + chain file in each card folder; CSV and JSON transfer logs in `REPORTS/ingest_verification/` |
| `rules.ts` | Where copies go (spec §5 folder model) and where they may never go |
| `media-service.ts` | Roles (remembered per volume), destination folders, the queue (one transfer at a time), retries, preflight (space, safety), what the screens see |
| `transfer-worker.ts` | Runs one transfer in a worker thread, so the window never stalls while gigabytes are hashed |

Copies land in `PRODUCTION/SHOOT_DAY_###_DATE/CAMERA_ORIGINALS/<card>/` (or
`SOUND_ORIGINALS`) on every destination, the card's own folder tree inside.
Scene/setup organization (spec §4.4) is a view over these, coming with the
local database.

## The production database (`src/main/db`)

One SQLite file per production (`*.vcdit`), so a production can be copied,
archived with its media, or handed to another cart as one file. SQLite runs
as WebAssembly (sql.js): no native module to build per platform. The database
is held in memory and written back half a second after each change, to a
temporary file renamed over the old one, so a crash mid-write never corrupts
it; opening a file keeps the previous version as `.bak`. The schema is
versioned (`pragma user_version`) and migrated forward on open; a file from a
newer app is refused rather than damaged.

| Table | Holds |
| --- | --- |
| `production` | Name, code, frame rate, checksum default, cameras and sound, naming template, the day open |
| `shoot_day` | Number, date, locations, DIT |
| `scene` | Each day's scene list and statuses (spec §4.1) |
| `transfer`, `transfer_destination` | Every card's ingest and where it went (spec "Transfer Record") |
| `clip`, `clip_copy` | Every file of every card: original path and name, size, checksum, and each copy's verification. The start of the media index: a clip is found by name across the production |

`library.ts` keeps the list of productions on the cart and which is open;
`project-ipc.ts` is what the screens call. Transfers are recorded when queued
and again when they end, so after a restart Verify shows the day as it was,
and a transfer cut off by a crash shows as failed, never as safe.

## The script supervisor's log (`src/main/scriptlog`)

| File | Does |
| --- | --- |
| `parse.ts` | Reads a log into neutral entries (spec §4.5): CSV or tab-separated text (columns recognised by name, title rows skipped), Avid ALE, JSON, XML. Scene, setup, take, camera, clip, roll, sound, TC in/out, circle, print, VFX and its note, notes, lens. A row it cannot read is skipped and reported, never guessed |
| `xml.ts` | A small XML reader: no DTDs or external entities |
| `clip-key.ts` | Clip names made comparable: "A015C002", "A15C2", A015C002_261005_R1AB.mxf, A015_C002_…R3D and A015_…_C002.braw are all `A015C002` |
| `match.ts` | Each take to its camera clips and sound file. A clip name on exactly one card matches; anything weaker (roll and time, a name on two cards, one clip claimed by two takes) goes to Match review with ranked candidates; nothing to go on is unmatched |
| `view.ts` | Scenes → setups → takes, the review list and the VFX flags, as the screens show them |

The database keeps each day's import, its rows, how each row matched, and
the DIT's decisions. Decisions are keyed by what the row says, so they
survive importing an updated log. Every finished card re-runs the match, so
takes logged before their card came in are matched when it does.

## Media integrity rules (spec §8), as engineering constraints

- **Originals are read-only.** The copy engine opens sources read-only; no
  code path renames, moves, or deletes on a volume classified Camera Source or
  Sound Source. Organization is done in destinations and in the index.
- **No "safe to format" without every required destination verified.** A
  destination is verified when its copy has been read back and its checksum
  matches the source's (xxHash64 by default for speed; MD5 and SHA-1
  selectable where a production requires them). The method is in every log.
- **A copy is unfinished until it is verified.** Each file is written as
  `<name>.vcdit-part` and renamed to its real name only after its read-back
  checksum matched the card's. A failed copy is removed, never left under a
  real name.
- **Nothing is overwritten.** A file already at a destination is compared
  with the card: identical counts as verified (so a re-run resumes a card),
  different is a failure and the file is left alone.
- **A vanished destination is never written into.** Before each file the
  engine checks the destination is still the same disk, so an unplugged
  drive cannot turn into a folder on the boot disk's `/Volumes`.
- **Failure is loud.** A failed or partial verification can never show green.
- **Known limit:** the read-back goes through the operating system, which may
  answer from its memory cache for files just written (most of a large card
  will not fit in it). Bypassing the cache needs native code (`F_NOCACHE` on
  macOS, `FILE_FLAG_NO_BUFFERING` on Windows); it is planned with the local
  database work.
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
2. Done: the media engine's first part. Volume detection, the
   multi-destination copy-and-verify engine in a worker thread, ASC MHL and
   transfer logs, wired to Intake, Verify and Today.
   Done: the production database: productions, shoot days, scene lists,
   transfers and every clip with its checksum, kept across restarts. The
   screens not yet on real data say so ("Sample data").
3. Done: script supervisor import and Match review; the Scene Organizer and
   Match review run on the real log and clips.
4. Sync, LUT / dailies rendering (FFmpeg plus camera SDKs where raw formats
   need them), VFX mirroring, delivery packages and manifests.
5. Frame.io, then Google Drive, as destination adapters.
