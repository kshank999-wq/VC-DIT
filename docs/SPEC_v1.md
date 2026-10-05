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
- No delete/format action should occur as part of V1; VC DIT may display 'Safe to Format' only after required verified copies succeed.
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

