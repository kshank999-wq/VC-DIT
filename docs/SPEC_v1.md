# VC DIT

**Digital Imaging Technician Workflow Platform**  
Development Specification — Version 1

Core concept: fast, verified camera/sound ingestion → automated organization → sync → dailies/look management → editorial/VFX handoff → multi-destination delivery.

## 1. Product Vision

VC DIT is a modular production-data application built around the real on-set DIT workflow. The system should reduce repetitive file handling while preserving camera originals, verification records, metadata, script-supervisor intent, production LUTs, and downstream editorial/VFX organization.

The core VC DIT product handles ingestion, checksum verification, media organization, sound synchronization, dailies/look preparation, script-supervisor integration, VFX shot mirroring, and delivery. A separate VC VFX Prep module can be licensed/used by a DIT on smaller productions or handed off to the VFX department/vendor on larger productions.

## 2. Primary Users

- Digital Imaging Technician (primary operator).
- Data Wrangler / Loader (delegated ingest and verification workflows).
- Editorial team receiving camera originals, synced material, metadata, and dailies.
- VFX team receiving mirrored VFX-designated material and, when applicable, VC VFX Prep packages.
- Cinematographer / production team supplying and reviewing production LUTs and looks.
- Script Supervisor supplying scene/take/select/VFX metadata used to organize the media.

## 3. End-to-End Workflow

1. Project / Shoot Day Setup: Create or open the production, select shoot date/day, enter scenes scheduled or actually photographed, import production LUTs, and load the script-supervisor log/report.

2. Source Detection: Detect mounted camera cards, sound media, shuttle drives, RAID/NAS volumes, and other supported storage as they are connected.

3. Destination Mapping: Select one or more simultaneous destinations for verified copies. Destinations may include local/removable drives, production storage, network storage, and Frame.io where supported.

4. Verified Ingestion: Copy media with checksum verification and create a permanent transfer/verification log. Never alter camera originals during ingest.

5. Metadata + Script Log Matching: Match camera and sound files to scenes, setups, shots, and takes using available metadata such as timecode, reel/clip name, slate information, filenames, and the imported script-supervisor log.

6. Automated Folder Organization: Build scene folders and setup folders automatically; retain all raw takes and identify circle/select takes without removing non-select material.

7. Audio Sync: Synchronize picture and production sound using timecode first, with waveform/manual fallback. Preserve source files and store sync relationships as metadata or generated synced deliverables.

8. Look / LUT Processing: Associate production LUTs with project/camera/scene as required and generate viewing/dailies outputs without baking a creative LUT into protected camera originals.

9. VFX Mirroring: When a take/shot is flagged VFX, retain it in its normal editorial scene/setup location and mirror/reference it into a separate VFX hierarchy organized by scene and setup.

10. Dailies / Review Package: Generate organized review-ready material, metadata, selects/circle-take indicators, and optional Frame.io upload structure.

11. Multi-Destination Export / Handoff: Deliver the organized package to multiple destinations and create a manifest confirming what was delivered, where, and with what verification status.

## 4. Module Specifications

### 4.1 Project & Shoot-Day Manager

- Production-level container with project name/code, production dates, cameras, sound recorder(s), LUT library, naming template, and destination presets.
- Shoot-day record allowing the DIT to enter/import the scenes being photographed that day.
- Ability to revise the scene list during the day as production changes.
- Persistent per-production settings so the DIT does not rebuild the workflow every card.

### 4.2 Media Detection & Intake

- Automatically detect newly mounted volumes and display device/volume name, capacity, free space, filesystem, and source type when available.
- Allow operator to designate a mounted volume as Camera Source, Sound Source, Destination, Shuttle, Archive, or Other.
- Support multiple camera cards and sound media per shoot day.
- Prevent accidental selection of a source card as a destructive destination.
- Queue-based intake so additional cards can be prepared while another transfer is running.

### 4.3 Multi-Destination Copy & Verification

- One ingest operation can write verified copies to multiple selected destinations.
- Checksum verification should be a first-class requirement; support industry-appropriate checksum methods and store the selected method in the transfer log.
- Display copy progress per source and per destination, throughput, elapsed/estimated time, verification state, warnings, and failures.
- Do not mark a card safe to format until all required destinations pass verification.
- Generate transfer logs/manifests that can be exported with the production package.

#### 4.3.1 Relay uploads: the card comes out, the upload carries on

Cloud destinations (LucidLink, Suite, Frame.io, Dropbox, a slow network share) can take hours on set internet, and the card is needed back in the camera long before that. So a slow destination is fed from the main backup, not from the card:

- In Destinations, each destination is either **From card** or **Upload from backup**. Cloud folders and network shares default to Upload; local drives, RAIDs and shuttles to From card. The operator can switch either, and the choice is remembered for that drive or folder. An ingest needs at least one From-card destination.
- Ingest copies the card to the From-card destinations and verifies them as before. The upload then starts on its own: it reads the backup with the most verified files (the RAID, normally) and writes to each upload destination, checking every file against the checksum taken **from the card**, not a new one from the backup. A backup copy that no longer matches the card is not uploaded.
- Uploads have their own queue, one at a time, running alongside card copies, so the next card never waits behind an upload.
- **Pause uploads / Resume uploads** (Intake and Verify) holds every upload; a stopped upload can be retried. If the backup is unplugged, the upload waits ("Waiting for RAID: plug it back in") and carries on when it is back. If the destination stops responding (internet down, filespace unmounted), it tries again a minute later. Paused, cut off, or closed with the app, an upload carries on later from the last verified file, the next time that day is open.
- Transfers shows each upload as card → backup ↑ destination with its own progress, file, speed and time left. Verify shows each card's uploads under it.
- **When a card is safe to format** is a production setting (Project setup → Safe to format when):
  - **Two local copies verified** (default): once at least two From-card copies have verified and none failed. Uploads do not count and do not hold the card up.
  - **Every destination verified, uploads included.**
  Before that, a card whose local copies are done shows **Can come out · don't format yet**. A failed upload still shows as a problem to deal with.
- Quitting with uploads unfinished asks first, and says they will carry on from the backup next time. The transfer record keeps each upload and the backup it came from.
- **Upload speed** (beside Pause uploads): no limit, or 1 to 100 MB/s, shown with the Mbit/s an internet connection is sold in, so an upload can be held to a share of the set's connection. It applies to all uploads together, changes a running upload at once, is remembered on that computer, and never slows a card copy.
- Not yet: uploads through a service's API (Frame.io, Google Drive), which will use the same queue when those integrations land.

### 4.4 Naming & Folder Automation

- Configurable naming convention centered on Production → Shoot Day → Scene → Setup → Take/Clip.
- Scene folders created from the day's scene list or script-supervisor import.
- Within each scene, create setup folders; within each setup, retain the applicable camera originals/takes.
- Circle/select status is metadata and/or a clearly organized subview; it must not cause the only copy of non-select material to be omitted.
- Naming templates must be customizable because productions differ in slate and camera naming conventions.
- Original camera filenames should be preserved or mapped non-destructively; the system should avoid renaming protected originals unless explicitly required by an approved workflow.

### 4.5 Script Supervisor Import & Matching

- Import a structured file exported from the script-supervisor system. Initial architecture should support CSV/JSON/XML-style structured interchange, with adapters added for specific products/formats later.
- Expected fields: scene, setup/shot, take, camera/reel/clip identifier, timecode where available, circle/select status, print status, notes, VFX flag, and other editorial notes.
- Automatically match log entries to camera and sound assets using strongest available identifiers.
- Provide a Match Review screen for ambiguous or unmatched items; never silently guess when confidence is low.
- Carry script-supervisor labels forward into folder organization, dailies metadata, VFX mirroring, and export manifests.

#### 4.5.1 Where clips go: four sources, one answer

- A camera clip's scene, setup and take can come from four sources: the **script supervisor's log**, the **camera report** (the AC's report), the **slate the sound recorder wrote** into the sound file synced to the clip (iXML scene/take), and the **DIT's own assignment**.
- The DIT's own word wins. Otherwise the sources that name a clip must agree (scene and setup compared together, so "14"+"B" = "14B"; "T03" = "3"); one source alone is enough. When they disagree the clip is not placed (it waits under UNMATCHED) and **Match Review decides**, showing what each source said and where it came from. The decision is kept.
- **Assign takes** (Organize) lists every clip of the day with where it goes and who says so, filters for clips not placed and sources that disagree, and places ticked clips by hand, one take each in a run ("C003–C006 as 22A takes 3–6"), or gives them back to the sources.
- **The camera report** is entered card by card (lines, or runs of clips numbered take by take) or imported (CSV/TSV/ALE: Roll, Clip, Scene, Setup, Take, Circle, Lens, Notes; template provided), and checked against the cards: a line naming a clip not on its card, and clips on a reported card the report leaves out. It can also be pulled from **VC Film Studio**, where the 2nd AC enters it on a phone (Get from Film Studio, with the production's upload key; the day is found by date, then number). A pull replaces Film Studio's rolls whole and takes out rolls Film Studio no longer has; a roll typed here or imported from a file is kept, and the DIT is told which. Stop and filter go in front of the notes.
- The scene and setup folders (`CAMERA_ORIGINALS/_BY_SCENE/SCENE_###/SETUP_X/<take>`, circle takes also under `SELECTS_CIRCLE_TAKES`) follow these assignments on every destination holding the clip, uploads included, as hard links to the card copy, or a reference file where the drive cannot hold links.
- **Read back on every drive**: after every change the folders are checked on every destination: each clip in its take's folder as the card's own data (the same file as the card copy, or a reference naming the clip and its files, with the card copy present). The result per drive ("RAID 212/212 in place") is shown in Assign takes and the Scene Organizer and goes into the day report; anything missing or wrong is listed and can be put back (a different file where a link would go is never replaced).

### 4.6 Picture / Sound Sync

- Ingest picture and production sound as separate source classes.
- Primary automatic sync: matching production timecode.
- Fallback sync: waveform/audio analysis when scratch audio is available.
- Manual offset/slate correction controls for exceptions.
- Batch sync by scene/setup/take and display confidence/status.
- Preserve original camera and sound assets; store sync relationship and generate synced proxies/dailies when requested.

### 4.7 LUT & Look Manager

- Import production LUTs and organize them per production.
- Support assignment by project default, camera, shoot day, scene, setup, or clip where appropriate.
- Preview footage through the selected LUT/look.
- Generate dailies/proxies with the viewing look applied when requested, while preserving untouched camera originals.
- Record LUT/look name in metadata and handoff reports so editorial/color know what was viewed on set.

### 4.8 Dailies Organizer

- Create review-ready dailies grouped by shoot day, scene, setup, and take.
- Clearly identify circle/select takes from the script-supervisor log.
- Include synced production audio when available.
- Include clip/slate metadata and relevant script notes.
- Provide optional upload/publish structure for Frame.io.

### 4.9 VFX Shot Mirroring & Handoff

- Any shot/take flagged VFX remains in the normal editorial/raw organization.
- The same asset is mirrored into a dedicated VFX hierarchy: VFX → Scene → Setup → Take/Clip.
- Prefer references/hard links/database pointers when safe and supported to avoid unnecessary storage duplication; use physical copy when a separate deliverable requires it.
- Carry VFX notes from the script supervisor into the mirrored record.
- Allow DIT to tag additional VFX candidates manually.
- Provide handoff into the separate VC VFX Prep module. Small productions may enable VC VFX Prep inside the DIT toolkit; large productions may export/hand off the same package to the VFX department.

### 4.10 Export & Delivery Manager

- Multi-destination output comparable to the multi-destination ingest workflow.
- Destination types: removable/local storage, production storage/NAS, network locations, and Frame.io integration where authorized.
- Export selectable package types: camera originals archive, editorial handoff, synced dailies, VFX package, reports/logs, or combined production-day package.
- Preflight destination capacity and warn before transfer.
- Verify copied deliverables and generate a delivery manifest showing files, destinations, timestamps, checksum/verification state, and failures/retries.
- Allow saved destination presets for recurring daily handoffs.

## 5. Proposed Folder Model

```
PRODUCTION_NAME/
  SHOOT_DAY_###_YYYY-MM-DD/
    CAMERA_ORIGINALS/
      SCENE_###/
        SETUP_A/
          [camera originals / takes]
        SETUP_B/
          [camera originals / takes]
    SOUND_ORIGINALS/
      [original production sound]
    SYNCED_DAILIES/
      SCENE_###/
        SETUP_A/
    SELECTS_CIRCLE_TAKES/
      [database view, references, or generated review copies]
    VFX/
      SCENE_###/
        SETUP_A/
          [mirrored/referenced VFX-designated shots]
    LUTS_LOOKS/
      [production LUTs + look metadata]
    REPORTS/
      script_supervisor/
      ingest_verification/
      sync/
      delivery_manifests/
```

Implementation note: the visible folder model should be configurable. Internally, VC DIT should maintain a database/media index so the same clip can appear in editorial, selects, and VFX views without requiring three physical copies.

## 6. Data Model — Core Records

| Record | Key Information |
|---|---|
| Production | ID, name/code, cameras, sound devices, LUT library, naming rules, destination presets |
| Shoot Day | date/day number, scheduled/shot scenes, notes, operator |
| Media Source | volume/card ID, camera/sound source, reel/card label, mount info |
| Clip / Audio File | original filename, checksum, timecode, reel, camera, metadata, source path |
| Scene / Setup / Take | script identifiers, slate values, relationships to clips/audio |
| Script Log Entry | scene/setup/take, select/circle, notes, VFX flag, identifiers, match confidence |
| Sync Record | picture asset, sound asset, method, offset, confidence, manual correction |
| Look Record | LUT/look file, scope/assignment, version, viewing/export use |
| Transfer Record | source, destination(s), checksum method, status, timestamp, verification |
| VFX Record | source clip, scene/setup/take, VFX notes, prep status, handoff status |

## 7. Key User Interface Screens

- Production Dashboard — current shoot day, cards waiting, active transfers, verification health, scenes shot, sync status, VFX count, delivery status.
- Media Intake — detected sources on the left; destination targets on the right; drag/add destination; start verified ingest.
- Transfer Monitor — card-by-card and destination-by-destination copy/verify status.
- Scene Organizer — scenes and setups for the day with matched/unmatched clips and script-supervisor data.
- Sync Workspace — batch timecode/waveform sync with exception review.
- LUT / Look Manager — production LUT library, assignment rules, preview, and dailies application.
- Dailies Builder — selects, synced media, metadata, look, codec/resolution presets, Frame.io publish target.
- VFX Handoff — VFX-designated assets organized by scene/setup, notes, prep eligibility, and send-to-VC-VFX-Prep action.
- Delivery Manager — choose package(s), multiple destinations, verification, and final manifest.

## 8. Safety / Data Integrity Requirements

- Camera and sound originals are treated as protected source media.
- VC DIT never formats a card, and shows 'Safe to Format' only after the required verified copies succeed (the production's format rule, §4.3.1).
- **A camera or sound card cannot be ejected from VC DIT until it is backed up:** everything on it now has verified on at least one drive copied straight from the card (an upload does not count), with nothing new or changed since. Until then its Eject button is locked ("Eject after backup") and Eject all leaves it in; the engine checks the card again before ejecting. A cleared or empty card may go. (Finder or Explorer can still eject it; VC DIT cannot stop that.)
- **A shuttle (or any drive copies go to) cannot be ejected from VC DIT until every card copied to it has verified there:** one still to copy, being copied, or whose copy failed keeps it in ("Eject when verified"; Eject all leaves it in), until the failed copy is retried and verifies.
- **Sealing a drive before it leaves set** (Seal…, on a shuttle or archive once everything on it has verified): every file the production copied to that drive, on every day, is checked against the drive (found by mount path or by name, so a changed drive letter does not matter). By default each file is read back and its checksum compared; the quick option checks presence and size only. A file missing or changed blocks the seal. Files in its card folders the production does not know are listed, not refused. A sealed drive gets `PRODUCTION/SEALS/SEAL_<drive>_<time>.csv` (every file, its size and checksum, and how it was checked) and a `.json` summary carrying the CSV's SHA-256. While sealing, nothing is copied to the drive and it cannot be ejected. The drive shows when it was sealed, and says so if a card was copied to it afterwards.
- **Clearing a card for camera** is the one erase it offers, and only on the operator's say-so:
  - When a card that is still plugged in becomes safe, VC DIT says so (a notice in the app, and the system notification when the window is in the background). Its tile in Sources turns green; while copying it is blue, a problem red, cleared grey.
  - **Clear card…** (on the tile, the notice, and Verify) first makes a fresh check: the card holds exactly the files that were copied (a new or changed clip stops it), and every copy the production's rule relies on verified at ingest and is still there now at the same size; under the two-local rule there must be at least two.
  - Then two confirmations: "All of this is backed up. Clear the card?" and "Are you sure? This permanently erases …". The check is made once more immediately before anything is erased.
  - Only the ingested files are erased, then any folders left empty; nothing else on the card is touched. The camera department formats the card in the camera before shooting on it again.
  - The clearing is recorded with the transfer, and a note (`<CARD>_cleared_<time>.json`) is written beside the transfer log on each copy relied on.
- All automatic organization should be reversible/non-destructive.
- Every transfer should be auditable through logs and checksums.
- Failed verification must be obvious and must prevent a green/completed status.
- VFX mirroring must never remove the editorial/raw instance of the shot.
- Low-confidence script-log or sync matches require operator review.

## 9. Integration Architecture

- Frame.io: authenticated destination/publish integration for dailies/review and, where appropriate, production deliverables.
- Script Supervisor: adapter layer for structured log imports; begin with a neutral interchange schema and add product-specific adapters.
- VC VFX Prep: shared project/media metadata schema so VFX-designated shots can be handed off without rebuilding scene/setup/take information.
- Future VC Film Studio integration: production schedule, script breakdown, camera notes, DIT logs, dailies, editorial, and VFX status can share the same production IDs.

## 10. MVP Scope

- Create production and shoot day; enter scenes.
- Detect mounted media and destinations.
- Verified multi-destination copy with logs.
- Camera + sound source classification.
- Automated scene/setup folder organization.
- Structured script-supervisor log import and match-review workflow.
- Circle/select and VFX flag ingestion.
- Timecode sync plus waveform fallback.
- Production LUT import/organization and proxy/dailies look application.
- VFX mirroring by scene/setup without removing raw/editorial media.
- Dailies package generation.
- Multi-destination export with verification and delivery manifest.
- Frame.io destination/publish integration.
- VC VFX Prep handoff package/interface.

## 11. Phase 2 / Expansion

- Direct integrations with major script-supervisor applications and camera/sound metadata ecosystems.
- Automated slate/scene/take recognition from image/audio where metadata is incomplete.
- Camera reports and lens metadata normalization.
- Live production status dashboard shared with editorial/VFX.
- Advanced color/CDL workflows and color metadata exchange.
- Near-set/cloud proxy workflows and remote editorial delivery.
- Automated VFX prep classification and processing through the optional VC VFX Prep module.
- Additional cloud object-storage and review-platform destinations.

## 12. Acceptance Criteria for V1

1. A DIT can connect a camera card and sound media and VC DIT recognizes the mounted volumes.
2. The operator can select at least two simultaneous destinations and complete checksum-verified copies with a readable transfer log.
3. The operator can create/import the day's scenes and the application can organize media into scene/setup structures.
4. A structured script-supervisor file can mark circle/select takes and VFX shots, with ambiguous matches presented for review.
5. Picture and sound can be batch synchronized by timecode, with fallback/manual exception handling.
6. Production LUTs can be imported, organized, previewed, and applied to generated viewing/dailies media without altering camera originals.
7. A VFX-flagged shot remains available in its original scene/setup organization and also appears under VFX → Scene → Setup.
8. The DIT can generate a dailies/editorial package and deliver it to multiple destinations.
9. The system can publish/upload an authorized review package to Frame.io.
10. Every completed ingest/export can produce a verification/delivery manifest.

## 13. Design Principle

VC DIT should feel like a production traffic-control system, not a generic file copier. The operator should be able to see where media came from, where it went, whether it verified, what scene/setup/take it belongs to, whether it is selected, whether it requires VFX, what look was used for viewing, whether sound is synced, and whether the downstream handoff is complete.

