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

## VFX mirroring (`src/main/vfx`)

A VFX shot (a camera clip of a take the log flags, or one the DIT tags) is
mirrored into `VFX/SCENE_###/SETUP_X/T##_<clip>/` on every destination that
holds a verified copy of it, beside `CAMERA_ORIGINALS`, which is only read.

| Method | What lands in the VFX folder | When |
| --- | --- | --- |
| Hard link (default) | The same data on disk as the editorial file: no extra space. Where the drive cannot hold links (exFAT, FAT32, some network shares) the shot is referenced instead, and the screen says so | As soon as the shot is flagged, matched and verified |
| Reference | `VFX_REFERENCE.json` / `.txt`: where the media is, with sizes and checksums | Same |
| Physical copy | A separate copy made by the transfer engine, read back, and checked against the checksum the card was ingested with, with its own ASC MHL | When the DIT presses "Mirror now" (copies share the drives with ingest) |

A file already in a VFX folder is never replaced. "Send to VC VFX Prep" writes
`VC_VFX_PREP_<code>_D###_<time>.json` (schema `vcdit.vfx-handoff/1`: production,
day, scene/setup/take, clip, notes, who flagged it, mirror folder, editorial
folder, files and checksums) and a CSV of the same into each destination's
`VFX/` folder, and marks those shots sent.

## Picture and sound sync (`src/main/media/metadata`, `src/main/sync`)

**Reading media headers** (no picture is decoded):

| Format | What is read |
| --- | --- |
| QuickTime / MP4 (ProRes, H.264, HEVC) | Frame rate, length, the timecode track (tmcd), uncompressed scratch audio (sowt, twos, in24, in32, lpcm, fl32, ipcm) |
| MXF (ARRI, Sony, Canon, Panasonic) | Start timecode (Timecode Component), picture rate and length, the sound descriptor, and frame- or clip-wrapped PCM scratch audio (picture elements are skipped by their length) |
| WAV / Broadcast WAV / RF64 | Format, length, start time (bext time reference) and the recorder's iXML (scene, take, roll, rate, track names) |
| R3D, BRAW, ARRIRAW .ari, Canon RAW | Not read: their timecode needs the vendor's SDK. Each clip says so |

Headers are read in the analysis worker as each card finishes, from a
verified destination copy (or the card if it is still in).

**Sync**, for every camera clip of the day:

1. *Timecode* (`plan.ts`): the sound file whose timecode covers the clip. Sound
   starts (seconds since midnight) become timecode frames at the clip's real rate,
   so 23.976 and 29.97 line up as they do on set.
2. *Checked by waveform* (`analyse.ts`) when the clip has scratch audio: if the
   waveform puts the sound more than a frame away from timecode, the sync waits
   for a look and says by how much (a recorder that was not jammed).
3. A whole-clip timecode match nothing disagrees with is accepted on its own;
   anything else waits for the DIT.
4. *Waveform pass* (on request) for clips timecode cannot place: the scratch audio
   against the log's sound file and the nearest in time (`waveform.ts`: log
   loudness, coarse search at 100 Hz, fine at 1 kHz; millisecond accuracy).
   Waveform results are never accepted without a look.
5. The DIT nudges by frames and accepts; those decisions are never redone.

Reading a clip's timecode also lets the log match takes that name no clip:
the logged timecode inside exactly one clip's own timecode is a match.

Test media: `src/main/__tests__/fixtures/` holds a short MOV and MXF made by
ffmpeg (`make-sync-fixtures.mjs`), with matching timecode and scratch audio.

## Looks and dailies (`src/main/looks`, `src/main/dailies`, `src/main/ffmpeg`)

**LUT library.** `.cube` (1D or 3D) and `.3dl` LUTs are checked on import
(row counts, sizes, numbers) and kept whole in the production database, so the
production file carries its looks. The first becomes the project default.
Rules assign looks by clip, setup (`14/B`), scene, day, camera letter, or the
project default; the most specific wins, and the Looks screen counts the clips
each rule decides. The preview is a real middle frame of a day's clip, as shot
and through the LUT, side by side under a split.

**Dailies** (per take: circle takes, all, or chosen scenes), each an FFmpeg run:

- the clip through its look (`lut3d`, tetrahedral), scaled to 1080 or 720,
  optionally letterboxed to 2.39;
- burn-ins: slate and circle, clip name, the clip's own running timecode, look,
  notes, watermark (IBM Plex Mono, shipped in `build/fonts`, SIL OFL). Text
  reaches FFmpeg as files in the job's folder, never escaped into the filter;
- the production sound laid in by its sync (skipped into or delayed by the
  sync offset), all tracks mixed or track 1, or the camera scratch;
- ProRes 422 Proxy/LT, DNxHR LB, or H.264 (libx264, else VideoToolbox / Media
  Foundation); the clip's timecode and the look's name go into the file.

Each daily is written as `.vcdit-part` and named when FFmpeg finishes;
a file VC DIT did not make is never replaced. Output goes to
`SYNCED_DAILIES/SCENE_###/SETUP_X/` (or by camera roll, or flat) on the
chosen destination, the looks to `LUTS_LOOKS/`, and a manifest with every
daily's xxHash64 to `REPORTS/dailies/`.

**FFmpeg** is a separate program the app runs, not linked into it. Packaging
fetches FFmpeg 6.0 static builds (ffmpeg-static project; macOS arm64 and
x64, both in the universal app; Windows x64), pinned by SHA-256
(`scripts/fetch-ffmpeg.mjs`), into `Resources/ffmpeg/<platform>-<arch>/` with
its licence and README. These builds are GPL (they include x264): distributing
them means offering FFmpeg's source and its licence with the app, which the
README and LICENSE beside the binary do; VC DIT's own code is not affected
because it only runs FFmpeg as a program. In development, `VCDIT_FFMPEG` or an
`ffmpeg` on the PATH is used. Frame.io publishing comes with the Frame.io
connection.

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
   Done: VFX mirroring (hard link, reference or verified copy) and the
   VC VFX Prep handoff package.
   Done: picture/sound sync by timecode, checked by waveform, with a waveform
   pass and manual nudges.
4. Done: the LUT library, assignment rules, look preview and dailies
   rendering with FFmpeg. Next: delivery packages and manifests; raw camera
   formats (R3D, BRAW, ARRIRAW) through their makers' SDKs.
5. Frame.io, then Google Drive, as destination adapters.
