import type {
  DailiesOptions,
  DeliveryDestination,
  DeliveryPackage,
  IngestDestination,
  Lut,
  LutRule,
  ManifestRow,
  MatchItem,
  Production,
  ReportRow,
  Scene,
  ScriptLogImport,
  ShootDay,
  SyncItem,
  Take,
  TransferJob,
  VfxShot,
  Volume,
} from './types';

/**
 * The HALCYON demo day from the UI handoff (design_handoff_vc_dit), so every
 * screen has something real-looking to show until the media engine fills the
 * same records from the cart's volumes.
 */

const p2 = (n: number) => String(n).padStart(2, '0');

export const PRODUCTION: Production = {
  name: 'HALCYON',
  code: 'HLC',
  frameRate: '23.976 fps',
  checksum: 'xxHash64',
  totalDays: 42,
  devices: [
    { slot: 'A', name: 'ARRI ALEXA 35', format: 'ARRIRAW 4.6K · LogC4' },
    { slot: 'B', name: 'Sony VENICE 2', format: 'X-OCN ST 8.6K · S-Log3' },
    { slot: 'S', name: 'Sound Devices 888', format: 'BWF 24-bit / 48 kHz · 8 trk' },
  ],
  namingTokens: ['{PROD}', '_', 'D{DAY}', '_', 'SC{SCENE}', '{SETUP}', '_', 'T{TAKE}', '_', '{CAM}{REEL}'],
};

export const DAY: ShootDay = {
  number: 14,
  date: '2026-10-05',
  locations: 'Hangar & Rooftop',
  operator: { name: 'Morgan Reyes', initials: 'MR' },
};

const SCENE_PLAN: { id: string; description: string; status: Scene['status']; vfx?: boolean; setups: [string, string, number][] }[] = [
  { id: '12', description: 'INT. CONTROL ROOM – DAY', status: 'Shot', setups: [['A', '32mm', 5], ['B', '50mm', 4]] },
  { id: '12A', description: 'INT. CORRIDOR – DAY', status: 'Shot', setups: [['A', '25mm', 3]] },
  { id: '14', description: 'INT. HANGAR – DAY', status: 'Shooting', setups: [['A', '21mm', 6], ['B', '40mm', 5], ['C', '75mm', 2]] },
  { id: '15', description: 'EXT. AIRFIELD – DUSK', status: 'Scheduled', setups: [] },
  { id: '21', description: 'EXT. ROOFTOP – NIGHT', status: 'Shot', vfx: true, setups: [['A', '35mm', 4], ['B', '65mm', 3]] },
  { id: '22', description: 'EXT. ROOFTOP – NIGHT', status: 'Scheduled', setups: [] },
];

const NOTES: Record<string, string> = {
  '14': 'Hangar door opens on cue at 0:12. Circle T3 and T5 — director prefers T5 performance, T3 for focus. Plane prop visible frame left in B setup.',
  '21': 'Greenscreen beyond rooftop rail. Tracking markers on rail. Rain towers on from T2.',
  '12': 'Monitors are practical playback — check flicker at 24 fps.',
  '12A': 'Steadicam walk-and-talk.',
};

const LOOKS: Record<string, string> = {
  '21': 'HLC_Night_Ext_v2.cube',
  '12': 'HLC_Show_LogC4_709_v3.cube',
  '12A': 'HLC_Show_LogC4_709_v3.cube',
  '14': 'HLC_Show_LogC4_709_v3.cube',
};

/** The prototype's take generator, kept so the numbers match the mockup. */
const buildScenes = (): Scene[] => {
  let a = 1;
  let b = 1;
  let h = 9;
  let mm = 4;
  return SCENE_PLAN.map((plan) => ({
    id: plan.id,
    description: plan.description,
    status: plan.status,
    notes: NOTES[plan.id] ?? '',
    look: LOOKS[plan.id] ?? 'HLC_Show_LogC4_709_v3.cube',
    setups: plan.setups.map(([setupId, lens, count]) => {
      const key = plan.id + setupId;
      const reel = plan.id.startsWith('12') ? '013' : plan.id === '21' ? '015' : '014';
      const takes: Take[] = [];
      for (let t = 1; t <= count; t += 1) {
        mm += 3;
        if (mm > 59) {
          mm -= 60;
          h += 1;
        }
        let match: Take['match'] = 'Matched';
        let sync: Take['sync'] = 'TC';
        if (key === '14B' && t === 4) {
          match = 'Review';
          sync = 'WF';
        }
        if (key === '14C' && t === 2) {
          match = 'Unmatched';
          sync = 'none';
        }
        if (key === '21A' && t === 3) match = 'Review';
        if (key === '12B' && t === 2) sync = 'WF';
        takes.push({
          id: `${plan.id}|${setupId}|T${p2(t)}`,
          take: `T${p2(t)}`,
          circle: t === count - 1 || (t === 2 && count > 4),
          vfx: Boolean(plan.vfx) || key === '14C',
          clipA: `A${reel}C${String(a++).padStart(3, '0')}`,
          clipB: plan.id === '12A' ? null : `B${plan.id.startsWith('12') ? '009' : '010'}C${String(b++).padStart(3, '0')}`,
          sound: `${key}-${p2(t)}.wav`,
          tc: `${p2(h)}:${p2(mm)}:${p2((t * 17) % 60)}:${p2((t * 7) % 24)}`,
          duration: `0${((t * 3) % 4) + 1}:${p2((t * 23) % 60)}`,
          match,
          sync,
        });
      }
      return { id: setupId, lens, takes };
    }),
  }));
};

export const SCENES: Scene[] = buildScenes();

export const VOLUMES: Volume[] = [
  { id: 'A015', name: 'A015', media: 'CFexpress B · 1 TB', filesystem: 'exFAT', used: '702 GB', fillPct: 70, detected: 'ALEXA 35 · ARRIRAW', role: 'Camera', included: true, ingested: false },
  { id: 'B010', name: 'B010', media: 'AXS · 1 TB', filesystem: 'UDF', used: '544 GB', fillPct: 54, detected: 'VENICE 2 · X-OCN ST', role: 'Camera', included: true, ingested: false },
  { id: 'SND2', name: '888_D14_02', media: 'SD · 128 GB', filesystem: 'FAT32', used: '6.1 GB', fillPct: 5, detected: '888 · BWF 24-bit/48k', role: 'Sound', included: true, ingested: false },
  { id: 'SHTL08', name: 'SHTL_08', media: 'SSD · 4 TB', filesystem: 'APFS', used: '0.2 TB', fillPct: 5, detected: 'Empty volume', role: 'Shuttle', included: false, ingested: false },
];

export const INGEST_DESTINATIONS: IngestDestination[] = [
  { id: 'RAID', name: 'HLC_RAID_01', kind: 'Primary RAID · Thunderbolt', free: '31.2 TB', fillPct: 35, selected: true },
  { id: 'SHTL07', name: 'SHTL_07', kind: 'Shuttle → Editorial', free: '5.1 TB', fillPct: 36, selected: true },
  { id: 'NAS', name: 'PROD_NAS', kind: 'Production storage · 10GbE', free: '84 TB', fillPct: 58, selected: true },
];

const leg = (name: string, copyPct: number, verifyPct: number, rate = 1, failed = false) => ({ name, copyPct, verifyPct, rate, failed });

export const JOBS: TransferJob[] = [
  {
    id: 'A013',
    label: 'Camera A · ALEXA 35',
    size: '540.8 GB',
    files: '1,102 files',
    queued: false,
    checksum: 'xxHash64',
    legs: [leg('HLC_RAID_01', 100, 100), leg('SHTL_06', 100, 100, 2, true), leg('PROD_NAS', 100, 100)],
  },
  {
    id: 'A014',
    label: 'Camera A · ALEXA 35',
    size: '612.4 GB',
    files: '1,284 files',
    queued: false,
    checksum: 'xxHash64',
    legs: [leg('HLC_RAID_01', 100, 100), leg('SHTL_07', 100, 58, 1.1), leg('PROD_NAS', 74, 0, 0.9)],
  },
  {
    id: 'B009',
    label: 'Camera B · VENICE 2',
    size: '488.0 GB',
    files: '312 files',
    queued: false,
    checksum: 'xxHash64',
    legs: [leg('HLC_RAID_01', 100, 100), leg('SHTL_07', 100, 100), leg('PROD_NAS', 100, 100)],
  },
  {
    id: '888_D14',
    label: 'Sound · 888',
    size: '4.2 GB',
    files: '96 files',
    queued: false,
    checksum: 'xxHash64',
    legs: [leg('HLC_RAID_01', 100, 100), leg('SHTL_07', 100, 100), leg('PROD_NAS', 100, 100)],
  },
  {
    id: 'A015',
    label: 'Camera A · ALEXA 35',
    size: '702.1 GB',
    files: '1,410 files',
    queued: true,
    checksum: 'xxHash64',
    legs: [leg('HLC_RAID_01', 0, 0, 1.6), leg('SHTL_07', 0, 0, 1.4), leg('PROD_NAS', 0, 0, 1.2)],
  },
];

export const MATCHES: MatchItem[] = [
  {
    id: 'm0',
    log: 'Sc 14 / B / T04',
    reason: 'Two clips inside the TC window; slate unreadable on the first.',
    fields: [['Scene', '14'], ['Setup', 'B'], ['Take', '4 ◎'], ['Camera', 'A'], ['Log TC', '14:22:10:04'], ['Note', 'Focus buzz at end']],
    candidates: [
      { clip: 'A014C018', tc: '14:22:09:18', confidence: 64, why: 'TC within 1s · no slate read' },
      { clip: 'A014C019', tc: '14:24:41:02', confidence: 22, why: 'Next clip on card' },
    ],
    picked: 0,
    resolution: null,
  },
  {
    id: 'm1',
    log: 'Sc 14 / C / T02',
    reason: 'No camera clip found for the logged reel. Possible reel mislabel (B010 vs B009).',
    fields: [['Scene', '14'], ['Setup', 'C'], ['Take', '2'], ['Camera', 'B'], ['Log reel', 'B009'], ['Note', 'VFX — plate for hangar ext.']],
    candidates: [{ clip: 'B010C004', tc: '15:02:11:20', confidence: 48, why: 'Matching TC on different reel' }],
    picked: 0,
    resolution: null,
  },
  {
    id: 'm2',
    log: 'Sc 21 / A / T03',
    reason: 'Log clip name "A015C07" differs from media "A015C007".',
    fields: [['Scene', '21'], ['Setup', 'A'], ['Take', '3'], ['Camera', 'A'], ['Log clip', 'A015C07'], ['Note', 'Rain on, circle']],
    candidates: [
      { clip: 'A015C007', tc: '19:40:02:11', confidence: 86, why: 'Name close match · TC match' },
      { clip: 'A015C008', tc: '19:43:18:00', confidence: 9, why: 'Adjacent clip' },
    ],
    picked: 0,
    resolution: null,
  },
];

export const SCRIPT_LOG: ScriptLogImport = { file: 'HLC_D014_scriptlog.csv', importedAt: '14:12', entries: 64, vfxFlags: 11 };

const syncRow = (take: string, clip: string, sound: string, method: SyncItem['method'], offsetFrames: number, confidence: number): SyncItem => ({
  take,
  clip,
  sound,
  method,
  offsetFrames,
  confidence,
  accepted: confidence >= 90,
});

export const SYNC: SyncItem[] = [
  syncRow('14A-01', 'A014C010', '14A-01.wav', 'Timecode', 0, 99),
  syncRow('14A-02', 'A014C011', '14A-02.wav', 'Timecode', 0, 99),
  syncRow('14A-03', 'A014C012', '14A-03.wav', 'Timecode', 0, 98),
  syncRow('14B-03', 'A014C017', '14B-03.wav', 'Timecode', 0, 99),
  syncRow('14B-04', 'A014C018', '14B-04.wav', 'Waveform', -3, 71),
  syncRow('14B-05', 'A014C019', '14B-05.wav', 'Timecode', 1, 93),
  syncRow('14C-01', 'B010C003', '14C-01.wav', 'Timecode', 0, 97),
  syncRow('14C-02', 'B010C004', '14C-02.wav', 'Manual', 0, 0),
  syncRow('21A-01', 'A015C005', '21A-01.wav', 'Timecode', 0, 99),
];

export const LUTS: Lut[] = [
  { name: 'HLC_Show_LogC4_709_v3.cube', description: 'Project default · DP approved 28 Sep' },
  { name: 'HLC_Venice_SLog3_709_v3.cube', description: 'Camera B match · v3' },
  { name: 'HLC_Night_Ext_v2.cube', description: 'Night exteriors · Sc 21–22' },
  { name: 'HLC_Show_LogC4_709_v2.cube', description: 'Superseded · kept for reference' },
];

export const LUT_RULES: LutRule[] = [
  { scope: 'Project', target: 'Default', lut: 'HLC_Show_LogC4_709_v3.cube', clips: 214 },
  { scope: 'Camera', target: 'Camera B', lut: 'HLC_Venice_SLog3_709_v3.cube', clips: 88 },
  { scope: 'Scene', target: 'Sc 21, 22', lut: 'HLC_Night_Ext_v2.cube', clips: 41 },
  { scope: 'Clip', target: 'A014C018', lut: 'HLC_Show_LogC4_709_v3.cube + CDL', clips: 1 },
];

const vfx = (scene: string, setup: string, take: string, clip: string, note: string, flaggedBy: VfxShot['flaggedBy'], prep: VfxShot['prep'] = 'eligible'): VfxShot => ({
  scene,
  setup,
  take,
  clip,
  note,
  flaggedBy,
  prep,
});

export const VFX: VfxShot[] = [
  vfx('21', 'A', '01', 'A015C005', 'Greenscreen beyond rail — full tracking markers', 'Script sup.'),
  vfx('21', 'A', '02', 'A015C006', 'Rain towers + GS. Clean plate after T2', 'Script sup.'),
  vfx('21', 'A', '03', 'A015C007', 'Hero take. Sky replacement, remove crane', 'Script sup.'),
  vfx('21', 'B', '01', 'A015C009', 'CU — GS spill on hair', 'Script sup.'),
  vfx('21', 'B', '02', 'A015C010', 'CU — eyeline marker removal', 'Script sup.'),
  vfx('14', 'C', '01', 'B010C003', 'Plate for hangar ext. comp', 'Script sup.'),
  vfx('14', 'C', '02', 'B010C004', 'Plate — match pending review', 'Script sup.', 'blocked'),
  vfx('14', 'B', '03', 'A014C017', 'Boom dip frame right — paint out?', 'DIT tag'),
];

export const DAILIES: DailiesOptions = {
  include: 'circle',
  codec: 'ProRes 422 Proxy',
  resolution: '1920 × 1080 · letterbox 2.39',
  audio: 'Synced · mix trk + boom',
  look: 'Per assignment rules',
  grouping: 'Scene → Setup → Take',
  destination: 'Frame.io + PROD_NAS',
  burnIns: { TC: true, 'Scene/Take': true, Look: true, Circle: true, Notes: false, 'Clip name': true, Watermark: true },
  built: false,
};

export const PACKAGES: DeliveryPackage[] = [
  { id: 'ocf', name: 'Camera originals archive', description: 'All OCF + sound originals, MHL', gb: 4820, selected: false },
  { id: 'edit', name: 'Editorial handoff', description: 'Originals by scene/setup, sync metadata, ALE', gb: 1210, selected: true },
  { id: 'dailies', name: 'Synced dailies', description: 'ProRes 422 Proxy · LUT applied', gb: 86, selected: true },
  { id: 'vfx', name: 'VFX package', description: 'Mirrored plates + notes for VC VFX Prep', gb: 640, selected: false },
  { id: 'reports', name: 'Reports & logs', description: 'Script, ingest, sync, look, manifests', gb: 0.04, selected: true },
];

export const DELIVERY_DESTINATIONS: DeliveryDestination[] = [
  { id: 'edit', name: 'EDIT_SHTL_03', kind: 'Shuttle → Editorial', freeGb: 1500, selected: true },
  { id: 'arc', name: 'ARCHIVE_NAS', kind: 'Archive · network', freeGb: 120000, selected: false },
  { id: 'fio', name: 'Frame.io · HALCYON / Dailies', kind: 'Cloud review', freeGb: Number.POSITIVE_INFINITY, selected: true },
  { id: 'vend', name: 'VENDOR_SFTP · Northlight', kind: 'VFX vendor · network', freeGb: 4000, selected: false },
];

export const LAST_MANIFEST: ManifestRow[] = [
  { pkg: 'Camera originals archive', destination: 'ARCHIVE_NAS', files: '2,941', size: '4.21 TB', completed: '21:48:12', verification: 'Verified', retried: false },
  { pkg: 'Editorial handoff', destination: 'EDIT_SHTL_02', files: '2,955', size: '1.08 TB', completed: '21:12:40', verification: 'Verified', retried: false },
  { pkg: 'Synced dailies', destination: 'Frame.io', files: '41', size: '78 GB', completed: '20:31:05', verification: 'Uploaded', retried: false },
  { pkg: 'VFX package', destination: 'VENDOR_SFTP', files: '118', size: '512 GB', completed: '22:04:51', verification: '1 retry · OK', retried: true },
  { pkg: 'Reports & logs', destination: 'All', files: '14', size: '36 MB', completed: '22:05:30', verification: 'Verified', retried: false },
];

export const REPORTS: ReportRow[] = [
  { step: 'verify', name: 'Ingest verification — A014', covers: 'ASC MHL · 1,284 files · 3 destinations', time: '14:31', status: 'Complete', screen: 'verify' },
  { step: 'verify', name: 'Ingest verification — B009', covers: 'ASC MHL · 312 files · 3 destinations', time: '13:02', status: 'Complete', screen: 'verify' },
  { step: 'verify', name: 'Ingest verification — 888_D14', covers: 'ASC MHL · 96 files · 3 destinations', time: '12:48', status: 'Complete', screen: 'verify' },
  { step: 'verify', name: 'Ingest verification — A013', covers: '2 checksum mismatches on SHTL_06', time: '11:20', status: 'Problem', screen: 'verify' },
  { step: 'organize', name: 'Script supervisor import', covers: 'HLC_D014_scriptlog.csv · 64 entries', time: '14:12', status: 'Needs you', screen: 'match' },
  { step: 'organize', name: 'Scene / setup organization', covers: '36 takes across 6 scenes', time: '14:32', status: 'Complete', screen: 'scenes' },
  { step: 'vfx', name: 'VFX mirror report', covers: '9 shots · hard links · notes', time: '14:32', status: 'Complete', screen: 'vfx' },
  { step: 'sync', name: 'Sync report', covers: '9 takes · timecode + waveform', time: '14:30', status: 'Needs you', screen: 'sync' },
  { step: 'output', name: 'Look / LUT report', covers: '4 LUTs · 4 assignment rules', time: '14:05', status: 'Complete', screen: 'looks' },
  { step: 'output', name: 'Delivery manifest — Day 013', covers: '5 packages · 4 destinations', time: '22:05', status: 'Complete', screen: 'delivery' },
];
