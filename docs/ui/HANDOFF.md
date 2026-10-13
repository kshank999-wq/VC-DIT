# Handoff: VC DIT — Digital Imaging Technician Workflow Platform (V1 UI)

## Overview
VC DIT is a desktop application for on-set DITs. It moves camera/sound media through a fixed pipeline:

**1 Intake → 2 Verify → 3 Organize → 4 VFX → 5 Audio Sync → 6 Output**

It must feel like a *production traffic-control system*: at any moment the operator can see where media came from, where it went, whether it verified, what scene/setup/take it belongs to, whether it's a select, whether it's VFX, what look was applied, whether sound is synced, and whether delivery is complete.

Source spec: `VCDIT_Development_Spec_v1.docx` (included). The spec is the authority for behavior and data rules; this README is the authority for UI.

## About the Design Files
The `.dc.html` files in this bundle are **design references built in HTML** — interactive prototypes showing intended look and behavior, **not production code**. Recreate them in the target codebase's environment (suggested if none exists: **Electron or Tauri + React + TypeScript**, since the app needs filesystem/volume access). Use the HTML for layout, tokens, copy and interaction; don't port its runtime.

Open a file directly in a browser to explore it. All data is mock data generated in each file's `<script data-dc-script>` logic class.

## Fidelity
**High-fidelity.** Colors, type, spacing, copy and interactions are final-intent. Two themes exist:
- `VC DIT Light.dc.html` — **primary / latest** (white background).
- `VC DIT v3.dc.html` — same UI, dark theme (keep as a theme option; on-set monitors are often in dark tents).

Earlier iterations (v1, v2) are included only for history; ignore them for implementation.

Image areas (viewer, thumbnails, LUT preview, match frames) are striped placeholders — replace with real decoded frames/proxies.

---

## App Shell (all screens)
Min window width **1280px**. CSS grid:

```
rows:    52px (header) | auto (flow bar) | 1fr (content)
columns: 1fr (main)    | 290px (Files panel, collapsible to 0)
```

### Header (52px, full width, bg panel, 1px bottom border)
Left → right, gap 16–20px, padding 0 18px:
1. Wordmark "VC DIT" (IBM Plex Sans 700 15px) + "V1.0" (Plex Mono 500 10px, muted). 150px, nowrap.
2. Production/day selector pill: `HALCYON` · `HLC` · divider · `DAY 014` · `Mon 05 Oct 2026` · ▾. 32px tall, radius 6, border. Opens shoot-day switcher.
3. Segmented tabs **Today** | **Project setup** (28px, radius 5; active = inverted text/bg).
4. Center: single **overall status pill** (30px, radius 15, tinted bg of status color, 8px dot). Text examples: "1 problem · 2 to check" (red), "3 things need you" (amber), "All good" (green). Click → most urgent screen.
5. **Reports** button, **Files** button (toggles right panel; filled when open). 30px, radius 6, 1px border.
6. Live clock `HH:MM:SS:FF` (Plex Mono 500 13px) + operator avatar (26px circle, initials; name in tooltip).

### Flow Bar (full width, padding 10px 14px, bottom border)
Six equal steps separated by "→". Each step (flex:1, radius 8, padding 9px 12px):
- 26×26 number badge filled with **step color**, number in white (light theme) / near-black (dark).
- Step name (Plex Sans 700 13.5px) — colored with step color when active.
- One-line metric (Plex Mono 500 11.5px, muted, ellipsis), e.g. "4/5 verified", "61/64 matched", "8 shots mirrored", "7/9 synced", "0/3 delivered".
- 9px status dot at right (status color; tooltip = status word).
- Active step: bg = step color @15% alpha, 1px border in step color. Inactive: 1px neutral border.
- Click navigates to the step's primary screen.

Step → screens:
| Step | Primary screen | Sub-tabs |
|---|---|---|
| 1 Intake | Media Intake | — |
| 2 Verify | Transfer Monitor | — |
| 3 Organize | Scene Organizer | Scene Organizer · Match Review |
| 4 VFX | VFX Handoff | — |
| 5 Audio Sync | Sync Workspace | — |
| 6 Output | Dailies | Looks · Dailies · Delivery |

Sub-tabs render as a pill row (30px, radius 6) under the flow bar; active pill is filled with the step color.

### Files Panel (right, 290px, panel bg, left border)
"Project files" title + volume label (`RAID_01`), search field (32px). Then a collapsible tree (rows 30px, indent 14px/level, ▸/▾ caret, 15×11 folder chip filled with the step color, Plex Mono 12.5px name — 700 weight for depth ≤1, count right-aligned, optional 7px status dot, "↗" marker for linked/virtual folders).

Tree (numbered to mirror the flow):
```
HALCYON/
  SHOOT_DAY_014/
    01_CAMERA_ORIGINALS/      (Intake color)  → SCENE_###/ → SETUP_X/  (Organize color)
    02_SOUND_ORIGINALS/       (Intake)
    03_SELECTS/ ↗             (Organize)  virtual view
    04_VFX/ ↗                 (VFX)       → SCENE_###/SETUP_X ↗
    05_SYNCED_DAILIES/        (Sync)
    06_LUTS_LOOKS/            (Output)
    07_DELIVERY/              (Output)    → EDITORIAL_HANDOFF, DAILIES_FRAMEIO, ARCHIVE
    08_REPORTS/               (neutral)   → ingest_verification, script_supervisor, sync, delivery_manifests
```
Clicking a folder toggles it and navigates to the related screen; clicking a SETUP folder opens it in Scene Organizer (highlighted with a 2px inset left bar in Organize color). Footer: color legend for the 6 steps + "↗ Linked folder — same clips, no extra copy."

**Spec rule:** ↗ folders are database views / hard links, never extra physical copies (spec §5, §4.9).

---

## Screens

Common screen header: eyebrow (Plex Mono 700 11px, letter-spacing .1em, step color, 10px square chip) e.g. `02 · VERIFY`; H1 Plex Sans 600 24px; one-sentence description 13px muted. Screen padding 24px 28px 40px; scrolls inside content area.

### Today (Dashboard)
- Muted line "Day 014 · Hangar & Rooftop · Mon 05 Oct"; headline H1 34px in overall status color (e.g. "1 card failed its check — fix that first.").
- 3×2 grid of step tiles (gap 14, radius 10, 4px top border in step color, min-height 160): step label, metric (Plex Sans 600 19px), description (13px muted), status dot+word, "Open →".
- "Do these next" list: rows (radius 10, padding 16/18) with status dot, title (600 14.5px), detail, step tag (mono, step color), primary button (e.g. Retry / Review / Open / Build).

### Project Setup
Two-column cards: Production fields (name, code, day, date, frame rate, default checksum) + Cameras & sound list; Day scene list (click status chip cycles Scheduled → Shooting → Shot → Dropped; "Add scene" input). Below: Naming template token chips (`{PROD}_D{DAY}_SC{SCENE}{SETUP}_T{TAKE}_{CAM}{REEL}`) with live folder preview; Script supervisor log import card (filename, Re-import, stats: Entries / Matched / Review / VFX flags).

### 01 Intake — Media Intake
Three-zone bordered container (radius 12, 1px strong border):
- **Left: IN · Sources** — header bar tinted Intake color with 2px bottom border. Cards per mounted volume: checkbox (include), volume name (Plex Mono 600 14), detected camera/format, media · used, **Role** button (cycles Camera / Sound / Destination / Shuttle / Archive / Other), capacity bar, "READ-ONLY" tag for Camera/Sound.
- **Center lane (210px)**: large "→", "COPY + CHECK", checksum options (xxHash64 / MD5 / SHA-1, stacked), "✓ Re-read after copy / ✓ ASC MHL + transfer log", summary ("2 sources → 3 destinations"), warning if <2 destinations, primary **Start verified ingest** button (Intake color).
- **Right: OUT · Destinations** — header tinted Verify color. Selectable destination cards (name, type, free space, fill bar). "+ Add destination or preset".
Rules: Camera/Sound volumes can never be destinations (spec §4.2). Start adds jobs to the queue and navigates to Verify.

### 02 Verify — Transfer Monitor
One card per source card. Header: card ID (Plex Mono 600 18), camera · size, status pill: **Safe to format** (green) / **Not safe yet · NN%** (neutral) / **Problem — don't format** (red, card border red) / **Waiting**. Body: 3-column grid, one cell per destination: name, status word ("Copying 74%", "Checking 58%", "Verified", "Failed"), 6px progress bar (combined copy+verify), red **Retry copy** button on failure.
Rule: "Safe to format" only when **all** destinations verified (spec §4.3, §8). Never offer a format/delete action in V1.

### 03 Organize — Scene Organizer (NLE media-page style)
Full-bleed grid: `190px bins | main`.
- **Bins (left)**: Smart bins (All clips / Circle takes / VFX shots with counts) and Scene bins (Scene → Setup, with takes count). Active = 3px inset bar in Organize color.
- **Main**: rows `1.15fr / 1fr`.
  - Top: `Viewer | 270px Clip info`. Viewer: 40px toolbar (eyebrow, "Scene 14 / Setup B", description, **LOOK ON/OFF** toggle), black stage with 2.39:1 frame + TC burn-in, 44px transport row (TC, |◀ ◀ ▶ ▶|, duration). Clip info: label/value rows (Scene, Setup, Take, Camera A, Camera B, Start TC, Duration, Sound, Sync, Look, Select, VFX, Script match, Verified) with colored values for statuses; script notes below.
  - Bottom: Media pool — toolbar with breadcrumb path (`01_CAMERA_ORIGINALS / SCENE_014 / SETUP_B`), thumbnail grid `repeat(auto-fill, minmax(160px,1fr))`, gap 10. Thumb card: 16:9 frame, take badge (top-left), **◎ SELECT** badge (top-right, amber), **VFX** badge (bottom-left, VFX color), sync dot (bottom-right), clip name + duration. Selected = 2px Organize-color border.
- Rule: all takes are always retained; selects/VFX are filtered views (spec §4.4).

### 03 Organize — Match Review
Left list of low-confidence items (log ref, reason, status chip). Right: Script log entry fields | "Why it needs review"; candidate media rows (radio, frame thumb, clip, reason, TC, confidence bar + %). Actions: **Mark unslated / wild**, **Confirm match** (advances to next unresolved). Rule: never auto-accept below 90% confidence (spec §4.5).

### 04 VFX — VFX Handoff
Table (Sc/Setup/Take, Clip, VFX note, Flagged by [Script sup. / DIT tag], Prep status chip: Eligible / Blocked · match / Sent to prep). Detail panel: clip, note, two location boxes (EDITORIAL · ORIGINAL path in green; VFX MIRROR path in VFX color), Mirror method segmented (Hard link / Reference / Physical copy) with explanation. Actions: "Export package for vendor", **Send to VC VFX Prep** (VFX color). Rule: mirroring never removes the editorial instance (spec §4.9).

### 05 Audio Sync — Sync Workspace
Top card: selected take, picture ⟷ sound, method, confidence; waveform compare (camera scratch vs production sound, center playhead line); offset nudge −/+ in frames ("1 frame @ 24 fps"); **Accept sync**. Table: Take, Picture, Sound, Method (Timecode/Waveform/Manual), Offset, Confidence, Status (Synced / Review / No TC). Batch actions: "Waveform pass on exceptions", "Batch sync Scene 14".

### 06 Output — Looks
LUT library list (selected = 2px left bar); preview with draggable split (viewing look vs LOG original); assignment rules table (Project / Camera / Scene / Clip scope → LUT, clip count, "most specific rule wins"). Rule: LUTs never baked into originals (spec §4.7).

### 06 Output — Dailies
Include selector (Circle takes only / All takes / By scene), field grid (Codec, Resolution, Audio, Look, Grouping, Destination), burn-in toggle chips, summary + **Build dailies**. Right card: Frame.io publish target tree preview.

### 06 Output — Delivery
Preset selector; Packages (checkbox cards with size), Destinations with **preflight** (free/remaining or "✕ short X TB" in red, border turns red, Deliver button disabled at 40% opacity). Summary bar + **Deliver & verify**. Manifest table for previous day (Package, Destination, Files, Size, Completed, Verification).

### Reports
Filter chips (All / Verify / Organize / VFX / Sync / Output). Table: Step tag (color), Report name, Covers, Time, Status (Complete / Needs you / Problem), **Open** (jumps to source screen) + **Export**. Top action "Export day package (PDF + MHL)".

---

## Interactions & Behavior
- Navigation: flow bar, sub-tabs, header tabs, Files tree, dashboard tiles/alerts all route to screens.
- Transfer simulation in prototype ticks every 500ms; real app should stream progress events per (source, destination) with copy % and verify %.
- Failure state blocks green status everywhere (flow bar dot, header pill, Files tree dot on 01_CAMERA_ORIGINALS, card border).
- Hover: rows/cards lighten one step (`#f0f0ee` light / `#1e1f24` dark). No animations beyond progress bars; keep transitions ≤150ms ease-out if added.
- Badges/dots: status is always shown as dot + word (never color alone).

## State (minimum)
- `screen`, `filesOpen`, `openFolders: Set<path>`
- `jobs[]`: `{id, label, size, files, queued, dests[]: {name, copyPct, verifyPct, failed}}`
- `volumes[]` with `role`, `included`; `selectedDestinations`; `checksum`
- `scenes[]` → `setups[]` → `takes[]` (`clipA, clipB, sound, tc, dur, circle, vfx, match, sync`)
- `selectedSetup`, `selectedClip`, `poolFilter: all|selects|vfx`, `lookOn`
- `matchItems[]` + `resolved{}`; `syncItems[]` (`method, offsetFrames, confidence, ok`)
- `luts[]`, `lutRules[]`; dailies options; delivery `packages{}`, `destinations{}`; `reportFilter`
Data model per spec §6 (Production, Shoot Day, Media Source, Clip/Audio, Scene/Setup/Take, Script Log Entry, Sync Record, Look Record, Transfer Record, VFX Record).

## Design Tokens

### Typography
- UI: **IBM Plex Sans** 400/500/600/700. Data/IDs/TC/paths: **IBM Plex Mono** 400/500/600/700 (Google Fonts).
- Scale: 34 (dashboard headline) · 24 (H1) · 19 (tile metric) · 15/14 (section titles) · 13.5/13/12.5 (body) · 12/11.5 (secondary) · 11/10.5 (mono labels, uppercase, letter-spacing .06–.1em).

### Step colors (light theme / dark theme)
| Step | Light | Dark |
|---|---|---|
| Intake | `oklch(0.52 0.17 255)` | `oklch(0.78 0.14 255)` |
| Verify | `oklch(0.54 0.11 220)` | `oklch(0.82 0.12 215)` |
| Organize | `oklch(0.53 0.10 180)` | `oklch(0.82 0.13 180)` |
| VFX | `oklch(0.50 0.19 300)` | `oklch(0.76 0.16 300)` |
| Audio Sync | `oklch(0.55 0.19 350)` | `oklch(0.78 0.15 345)` |
| Output | `oklch(0.24 0 0)` | `oklch(0.96 0 0)` |

### Status colors (light / dark)
- Done `oklch(0.55 0.15 150)` / `oklch(0.80 0.18 150)`
- Working `oklch(0.32 0 0)` / `oklch(0.92 0 0)`
- Needs you `oklch(0.60 0.14 70)` / `oklch(0.84 0.16 80)`
- Problem `oklch(0.55 0.21 25)` / `oklch(0.69 0.21 25)`
- Tints: status/step color at 15% alpha for pill backgrounds.

### Neutrals (light / dark)
- App bg `#ffffff` / `#0a0a0b`; panel (header, flow bar, files, bins) `#f5f5f3` / `#0f0f11`; card `#ffffff` / `#151618`
- Hover `#f0f0ee` / `#1e1f24`; selected `#e8e8e5` / `#26272c`
- Row divider `#ececea` / `#25262b`; border `#dededa` / `#33353a`; strong border `#c9c9c4` / `#46484e`
- Text `#141414` / `#f7f6f3`; muted `#55534e` / `#c2c0b9`; label `#64625d` / `#a6a49d`; faint `#6c6a65` / `#99978f`
- Viewer stage always `#000`.

### Radius / spacing / shadow
- Radius: 3–4 (badges), 5–6 (buttons, inputs, chips), 8 (cards, flow steps), 10–12 (major cards/containers), 13–15 (pills).
- Control heights: 26, 28, 30, 32, 34, 36, 40/42 (primary CTA).
- Spacing: 4 / 6 / 8 / 10 / 12 / 14 / 16 / 18 / 20 / 24 / 28 / 32.
- Shadow (light cards only): `0 1px 2px rgba(0,0,0,.04)`.

## Assets
No bitmap assets or icon set. Glyphs used: → ▸ ▾ ◎ ↗ ✓ ✕ ▶ ◀. Folder chips/dots are plain CSS shapes. Replace image placeholders with real frames; adopt an icon set (e.g. Lucide) if the codebase has one.

## Files
- `VC DIT Light.dc.html` — primary reference (light theme)
- `VC DIT v3.dc.html` — dark theme reference (identical structure)
- `VCDIT_Development_Spec_v1.docx` — product/development spec
- `history/VC DIT.dc.html`, `history/VC DIT v2.dc.html` — superseded iterations
- `support.js` — runtime needed to open the `.dc.html` files in a browser (not part of the design)
