import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type Dispatch, type ReactNode } from 'react';
import type { MediaState } from '../../shared/media';
import type { DailyRender, DeliveryPackageId, DeliveryState, OrganizeState, ProjectState } from '../../shared/project';
import * as demo from '../model/demo';
import type {
  ChecksumMethod,
  DailiesOptions,
  DeliveryDestination,
  DeliveryPackage,
  IngestDestination,
  Lut,
  LutRule,
  MatchItem,
  MirrorMethod,
  Production,
  Scene,
  SceneStatus,
  ScreenId,
  ScriptLogImport,
  ShootDay,
  StepId,
  SyncItem,
  TransferJob,
  VfxShot,
  Volume,
  VolumeRole,
} from '../model/types';
import { engine, fromEngine, fromProject, persist, projectApi } from './engine';

/**
 * The whole UI state and every way it changes, in one reducer, so each
 * screen is a view of it and the status shown in the header, the flow bar,
 * the file tree and Today can never disagree (they are all derived in
 * model/status.ts).
 *
 * In the desktop app the production database (src/main/db) holds the
 * production, the day and its scene list (`projectState`; edits are written
 * back by `persist`), and the media engine (src/main/media) owns the
 * volumes, destinations and transfers (`engineState`). In the browser
 * preview and the tests the HALCYON demo day stands in for both (the `tick`
 * action advances simulated transfers).
 */

export type PoolFilter = 'all' | 'circle' | 'vfx';
export type ThemeChoice = 'light' | 'dark' | 'system';
export type ReportFilter = 'all' | StepId;

export interface AppState {
  /** Volumes, destinations and transfers come from the real media engine. */
  engine: boolean;
  /** The open production's file, its days and the recent productions, when the database is in use. */
  project: { file: string; days: ShootDay[]; recent: { file: string; name: string }[] } | null;
  screen: ScreenId;
  filesOpen: boolean;
  theme: ThemeChoice;
  openFolders: string[];
  production: Production;
  day: ShootDay;
  scenes: Scene[];
  scriptLog: ScriptLogImport;
  volumes: Volume[];
  destinations: IngestDestination[];
  checksum: ChecksumMethod;
  jobs: TransferJob[];
  /** Scene Organizer: `${scene}|${setup}`, the take id, and the pool filter. */
  selectedSetup: string;
  selectedTake: string | null;
  poolFilter: PoolFilter;
  lookOn: boolean;
  matches: MatchItem[];
  selectedMatch: string;
  sync: SyncItem[];
  selectedSync: number;
  luts: Lut[];
  lutRules: LutRule[];
  selectedLut: number;
  split: number;
  vfx: VfxShot[];
  selectedVfx: number;
  mirrorMethod: MirrorMethod;
  /** What the VFX mirroring is doing now, in the desktop app. */
  vfxActivity: string | null;
  /** What sync is doing now, in the desktop app. */
  syncActivity: string | null;
  /** The desktop app's dailies: clips a look can be previewed on, what was rendered, what is rendering, and the FFmpeg doing it. */
  previewClips: { id: string; label: string }[];
  renders: DailyRender[];
  dailiesActivity: string | null;
  ffmpeg: { version: string } | null;
  dailies: DailiesOptions;
  packages: DeliveryPackage[];
  deliveryDestinations: DeliveryDestination[];
  deliveryPreset: string;
  delivered: string[];
  /** The desktop app's delivery: choices, drives, manifest and progress. */
  delivery: DeliveryState | null;
  /** The desktop app's scene folders on the destinations. */
  organize: OrganizeState | null;
  /** The desktop app's count of the day's media, for the Files panel. */
  media: ProjectState['media'] | null;
  reportFilter: ReportFilter;
}

export const initialState = (): AppState => ({
  engine: false,
  project: null,
  screen: 'today',
  filesOpen: true,
  theme: 'system',
  openFolders: ['root', 'day', 'ocf', 'ocf/14', 'vfx', 'rep'],
  production: structuredClone(demo.PRODUCTION),
  day: structuredClone(demo.DAY),
  scenes: structuredClone(demo.SCENES),
  scriptLog: structuredClone(demo.SCRIPT_LOG),
  volumes: structuredClone(demo.VOLUMES),
  destinations: structuredClone(demo.INGEST_DESTINATIONS),
  checksum: demo.PRODUCTION.checksum,
  jobs: structuredClone(demo.JOBS),
  selectedSetup: '14|B',
  selectedTake: null,
  poolFilter: 'all',
  lookOn: true,
  matches: structuredClone(demo.MATCHES),
  selectedMatch: demo.MATCHES[0]!.id,
  sync: structuredClone(demo.SYNC),
  selectedSync: 4,
  luts: structuredClone(demo.LUTS),
  lutRules: structuredClone(demo.LUT_RULES),
  selectedLut: 0,
  split: 50,
  vfx: structuredClone(demo.VFX),
  selectedVfx: 2,
  mirrorMethod: 'Hard link',
  vfxActivity: null,
  syncActivity: null,
  previewClips: [],
  renders: [],
  dailiesActivity: null,
  ffmpeg: null,
  dailies: structuredClone(demo.DAILIES),
  packages: structuredClone(demo.PACKAGES),
  deliveryDestinations: demo.DELIVERY_DESTINATIONS.map((destination) => ({ ...destination })),
  deliveryPreset: 'Daily handoff — Editorial + Archive',
  delivered: [],
  delivery: null,
  organize: null,
  media: null,
  reportFilter: 'all',
});

export type Action =
  | { type: 'go'; screen: ScreenId }
  | { type: 'toggleFiles' }
  | { type: 'setTheme'; theme: ThemeChoice }
  | { type: 'toggleFolder'; path: string }
  // Project setup
  | { type: 'setProduction'; patch: Partial<Production> }
  | { type: 'setDay'; patch: Partial<Omit<ShootDay, 'number'>> }
  | { type: 'setSceneStatus'; scene: string; status: SceneStatus }
  | { type: 'addScene'; id: string; description: string }
  | { type: 'removeScene'; scene: string }
  | { type: 'projectState'; project: ProjectState }
  | { type: 'reimportScriptLog' }
  // Intake
  | { type: 'setVolumeRole'; volume: string; role: VolumeRole }
  | { type: 'toggleVolume'; volume: string }
  | { type: 'toggleDestination'; destination: string }
  | { type: 'setChecksum'; checksum: ChecksumMethod }
  | { type: 'startIngest' }
  // Verify
  | { type: 'tick' }
  | { type: 'retryLeg'; job: string; leg: string }
  | { type: 'engineState'; media: MediaState }
  // Organize
  | { type: 'selectSetup'; key: string }
  | { type: 'selectTake'; take: string }
  | { type: 'setPoolFilter'; filter: PoolFilter }
  | { type: 'toggleLook' }
  | { type: 'selectMatch'; id: string }
  | { type: 'pickCandidate'; id: string; index: number }
  | { type: 'confirmMatch'; id: string }
  | { type: 'markWild'; id: string }
  // VFX
  | { type: 'selectVfx'; index: number }
  | { type: 'setMirrorMethod'; method: MirrorMethod }
  | { type: 'sendToPrep' }
  | { type: 'tagVfx'; clip: string; note: string }
  // Sync
  | { type: 'selectSync'; index: number }
  | { type: 'nudgeSync'; frames: number }
  | { type: 'acceptSync' }
  | { type: 'waveformPass' }
  | { type: 'batchSync'; scene: string }
  // Looks
  | { type: 'selectLut'; index: number }
  | { type: 'setSplit'; split: number }
  // Dailies
  | { type: 'setDailies'; patch: Partial<DailiesOptions> }
  | { type: 'toggleBurnIn'; key: string }
  | { type: 'buildDailies' }
  // Delivery
  | { type: 'togglePackage'; id: string }
  | { type: 'toggleDeliveryDestination'; id: string }
  | { type: 'deliver' }
  | { type: 'setDeliveryChoice'; packages: DeliveryPackageId[]; destinations: string[] }
  // Reports
  | { type: 'setReportFilter'; filter: ReportFilter };

/** Where each setting's source lives, for roles that may receive copies. */
export const DESTINATION_ROLES: VolumeRole[] = ['Destination', 'Shuttle', 'Archive'];
export const SOURCE_ROLES: VolumeRole[] = ['Camera', 'Sound'];

const legDone = (leg: TransferJob['legs'][number]) => leg.copyPct >= 100 && leg.verifyPct >= 100;
const jobRunning = (job: TransferJob) => !job.queued && job.legs.some((leg) => !leg.failed && !legDone(leg));

/** Advance every running transfer one step: copy first, then the read-back check. */
const advance = (jobs: TransferJob[]): TransferJob[] => {
  let next = jobs.map((job) => {
    if (job.queued) return job;
    return {
      ...job,
      legs: job.legs.map((leg) => {
        if (leg.failed || legDone(leg)) return leg;
        if (leg.copyPct < 100) return { ...leg, copyPct: Math.min(100, leg.copyPct + 4 * leg.rate) };
        return { ...leg, verifyPct: Math.min(100, leg.verifyPct + 5 * leg.rate) };
      }),
    };
  });
  // One card at a time per destination set: the next queued card starts when nothing else is copying.
  if (!next.some(jobRunning)) {
    const waiting = next.findIndex((job) => job.queued);
    if (waiting >= 0) next = next.map((job, index) => (index === waiting ? { ...job, queued: false } : job));
  }
  return next;
};

const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

export const reducer = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case 'go':
      return { ...state, screen: action.screen };
    case 'toggleFiles':
      return { ...state, filesOpen: !state.filesOpen };
    case 'setTheme':
      return { ...state, theme: action.theme };
    case 'toggleFolder':
      return { ...state, openFolders: toggle(state.openFolders, action.path) };

    case 'setProduction':
      return { ...state, production: { ...state.production, ...action.patch } };
    case 'setDay':
      return { ...state, day: { ...state.day, ...action.patch, operator: { ...state.day.operator, ...action.patch.operator } } };
    case 'removeScene':
      return { ...state, scenes: state.scenes.filter((scene) => scene.id !== action.scene) };
    case 'projectState':
      return { ...state, ...fromProject(state, action.project) };
    case 'setSceneStatus':
      return { ...state, scenes: state.scenes.map((scene) => (scene.id === action.scene ? { ...scene, status: action.status } : scene)) };
    case 'addScene': {
      const id = action.id.trim().toUpperCase();
      if (!id || state.scenes.some((scene) => scene.id === id)) return state;
      return {
        ...state,
        scenes: [...state.scenes, { id, description: action.description.trim() || 'Added on the day', status: 'Scheduled', notes: '', look: state.project ? '' : (state.luts[0]?.name ?? ''), setups: [] }],
      };
    }
    case 'reimportScriptLog':
      return { ...state, scriptLog: { ...state.scriptLog, importedAt: new Date().toTimeString().slice(0, 5) } };

    case 'setVolumeRole':
      return {
        ...state,
        volumes: state.volumes.map((volume) =>
          volume.id === action.volume
            ? // A card can never be a destination, and only a card is ever ingested (spec §4.2).
              // A volume just marked to receive copies is picked as a destination.
              {
                ...volume,
                role: action.role,
                included: SOURCE_ROLES.includes(action.role) ? volume.included : DESTINATION_ROLES.includes(action.role),
              }
            : volume,
        ),
      };
    case 'toggleVolume':
      return {
        ...state,
        volumes: state.volumes.map((volume) =>
          volume.id === action.volume && SOURCE_ROLES.includes(volume.role) ? { ...volume, included: !volume.included } : volume,
        ),
      };
    case 'toggleDestination': {
      const fixed = state.destinations.find((destination) => destination.id === action.destination);
      if (fixed) {
        return { ...state, destinations: state.destinations.map((destination) => (destination === fixed ? { ...destination, selected: !destination.selected } : destination)) };
      }
      // A mounted volume used as a destination (a shuttle, say): only when its role allows it.
      const volume = state.volumes.find((candidate) => candidate.id === action.destination);
      if (!volume || !DESTINATION_ROLES.includes(volume.role)) return state;
      return { ...state, volumes: state.volumes.map((candidate) => (candidate === volume ? { ...candidate, included: !candidate.included } : candidate)) };
    }
    case 'setChecksum':
      return { ...state, checksum: action.checksum };
    case 'startIngest': {
      const legs = [
        ...state.destinations.filter((destination) => destination.selected).map((destination) => destination.name),
        ...state.volumes.filter((volume) => DESTINATION_ROLES.includes(volume.role) && volume.included).map((volume) => volume.name),
      ];
      const sources = state.volumes.filter((volume) => SOURCE_ROLES.includes(volume.role) && volume.included && !volume.ingested);
      if (legs.length === 0 || sources.length === 0) return state;
      const fresh = sources
        .filter((volume) => !state.jobs.some((job) => job.id === volume.name))
        .map<TransferJob>((volume) => ({
          id: volume.name,
          label: volume.role === 'Sound' ? `Sound · ${volume.detected.split(' · ')[0]}` : `Camera ${volume.name[0]} · ${volume.detected.split(' · ')[0]}`,
          size: volume.used,
          files: '—',
          queued: true,
          checksum: state.checksum,
          legs: legs.map((name, index) => ({ name, copyPct: 0, verifyPct: 0, failed: false, rate: 1.2 + index * 0.15 })),
        }));
      return {
        ...state,
        screen: 'verify',
        // Cards already queued with this name (the demo's A015) keep their place.
        jobs: [...state.jobs.map((job) => (sources.some((volume) => volume.name === job.id) ? { ...job, checksum: state.checksum } : job)), ...fresh],
        volumes: state.volumes.map((volume) => (sources.includes(volume) ? { ...volume, ingested: true } : volume)),
      };
    }

    case 'tick': {
      const jobs = advance(state.jobs);
      return jobs.every((job, index) => job === state.jobs[index]) ? state : { ...state, jobs };
    }
    case 'engineState':
      return { ...state, ...fromEngine(state, action.media) };
    case 'retryLeg':
      return {
        ...state,
        jobs: state.jobs.map((job) =>
          job.id === action.job
            ? { ...job, legs: job.legs.map((leg) => (leg.name === action.leg ? { ...leg, failed: false, copyPct: 0, verifyPct: 0 } : leg)) }
            : job,
        ),
      };

    case 'selectSetup':
      return { ...state, selectedSetup: action.key, selectedTake: null, screen: 'scenes' };
    case 'selectTake':
      return { ...state, selectedTake: action.take };
    case 'setPoolFilter':
      return { ...state, poolFilter: action.filter, selectedTake: null };
    case 'toggleLook':
      return { ...state, lookOn: !state.lookOn };
    case 'selectMatch':
      return { ...state, selectedMatch: action.id };
    case 'pickCandidate':
      return { ...state, matches: state.matches.map((match) => (match.id === action.id ? { ...match, picked: action.index } : match)) };
    case 'confirmMatch':
    case 'markWild': {
      const matches = state.matches.map((match) => {
        if (match.id !== action.id) return match;
        const candidate = match.candidates[match.picked];
        return {
          ...match,
          resolution: action.type === 'markWild' || !candidate ? ({ kind: 'wild' } as const) : ({ kind: 'matched', clip: candidate.clip } as const),
        };
      });
      // Move on to the next one still open, so a run of decisions is a run of keystrokes.
      const next = matches.find((match) => match.resolution === null);
      // A resolved match unblocks the VFX shot that was waiting on it.
      const resolved = matches.find((match) => match.id === action.id);
      const clip = resolved?.resolution?.kind === 'matched' ? resolved.resolution.clip : null;
      return {
        ...state,
        matches,
        selectedMatch: next?.id ?? action.id,
        vfx: clip ? state.vfx.map((shot) => (shot.clip === clip && shot.prep === 'blocked' ? { ...shot, prep: 'eligible' } : shot)) : state.vfx,
      };
    }

    case 'selectVfx':
      return { ...state, selectedVfx: action.index };
    case 'setMirrorMethod':
      return { ...state, mirrorMethod: action.method };
    case 'sendToPrep':
      return { ...state, vfx: state.vfx.map((shot) => (shot.prep === 'eligible' ? { ...shot, prep: 'sent' } : shot)) };
    case 'tagVfx': {
      if (!action.clip.trim() || state.vfx.some((shot) => shot.clip === action.clip.trim())) return state;
      let found: { scene: string; setup: string; take: string } | null = null;
      for (const scene of state.scenes) {
        for (const setup of scene.setups) {
          const take = setup.takes.find((candidate) => candidate.clipA === action.clip.trim() || candidate.clipB === action.clip.trim());
          if (take) found = { scene: scene.id, setup: setup.id, take: take.take.slice(1) };
        }
      }
      return {
        ...state,
        vfx: [...state.vfx, { scene: found?.scene ?? '—', setup: found?.setup ?? '—', take: found?.take ?? '—', clip: action.clip.trim(), note: action.note.trim(), flaggedBy: 'DIT tag', prep: 'eligible' }],
      };
    }

    case 'selectSync':
      return { ...state, selectedSync: action.index };
    case 'nudgeSync':
      return {
        ...state,
        sync: state.sync.map((item, index) =>
          index === state.selectedSync ? { ...item, offsetFrames: item.offsetFrames + action.frames, method: item.method === 'Timecode' ? 'Manual' : item.method } : item,
        ),
      };
    case 'acceptSync': {
      const sync = state.sync.map((item, index) => (index === state.selectedSync ? { ...item, accepted: true } : item));
      const next = sync.findIndex((item) => !item.accepted);
      return { ...state, sync, selectedSync: next >= 0 ? next : state.selectedSync };
    }
    case 'waveformPass':
      // In the desktop app the real waveform pass answers (state/engine.ts persist).
      if (state.project) return state;
      // Exceptions with no timecode get a waveform attempt; it raises confidence but still asks for a look.
      return {
        ...state,
        sync: state.sync.map((item) =>
          !item.accepted && item.confidence < 50 ? { ...item, method: 'Waveform', confidence: 78, offsetFrames: item.offsetFrames || 2 } : item,
        ),
      };
    case 'batchSync':
      return { ...state, sync: state.sync.map((item) => (item.take.startsWith(action.scene) && item.confidence >= 90 ? { ...item, accepted: true } : item)) };

    case 'selectLut':
      return { ...state, selectedLut: action.index };
    case 'setSplit':
      return { ...state, split: Math.max(0, Math.min(100, action.split)) };

    case 'setDailies':
      return { ...state, dailies: { ...state.dailies, ...action.patch, built: false } };
    case 'toggleBurnIn':
      return { ...state, dailies: { ...state.dailies, burnIns: { ...state.dailies.burnIns, [action.key]: !state.dailies.burnIns[action.key] }, built: false } };
    case 'buildDailies':
      // In the desktop app the Dailies screen starts the real render.
      if (state.project) return state;
      return { ...state, dailies: { ...state.dailies, built: true } };

    case 'togglePackage': {
      const next = { ...state, packages: state.packages.map((pkg) => (pkg.id === action.id ? { ...pkg, selected: !pkg.selected } : pkg)) };
      if (!state.delivery) return next;
      const chosen = state.delivery.settings.packages;
      const id = action.id as DeliveryPackageId;
      const packages = chosen.includes(id) ? chosen.filter((pkg) => pkg !== id) : [...chosen, id];
      return { ...next, delivery: { ...state.delivery, settings: { ...state.delivery.settings, packages } } };
    }
    case 'toggleDeliveryDestination': {
      const next = {
        ...state,
        deliveryDestinations: state.deliveryDestinations.map((destination) => (destination.id === action.id ? { ...destination, selected: !destination.selected } : destination)),
      };
      if (!state.delivery) return next;
      const chosen = state.delivery.settings.destinations;
      const destinations = chosen.includes(action.id) ? chosen.filter((id) => id !== action.id) : [...chosen, action.id];
      return { ...next, delivery: { ...state.delivery, settings: { ...state.delivery.settings, destinations } } };
    }
    case 'setDeliveryChoice':
      if (!state.delivery) return state;
      return {
        ...state,
        packages: state.packages.map((pkg) => ({ ...pkg, selected: action.packages.includes(pkg.id as DeliveryPackageId) })),
        delivery: { ...state.delivery, settings: { ...state.delivery.settings, packages: action.packages, destinations: action.destinations } },
      };
    case 'deliver':
      return { ...state, delivered: state.packages.filter((pkg) => pkg.selected).map((pkg) => pkg.id) };

    case 'setReportFilter':
      return { ...state, reportFilter: action.filter };
  }
};

const THEME_KEY = 'vcdit.theme';

const readTheme = (): ThemeChoice => {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
  } catch {
    return 'system';
  }
};

const StoreContext = createContext<{ state: AppState; dispatch: Dispatch<Action> } | null>(null);

export function StoreProvider({ children, initial, simulate = true }: { children: ReactNode; initial?: AppState; simulate?: boolean }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    if (initial) return initial;
    let start: AppState = { ...initialState(), theme: readTheme() };
    // With the real engine, no demo cards or transfers: only what is plugged in.
    if (engine()) start = { ...start, engine: true, volumes: [], destinations: [], jobs: [] };
    // With the database, the production open on this cart, from the first frame.
    const project = projectApi();
    if (project) start = { ...start, ...fromProject({ ...start, scenes: [] }, project.now()) };
    return start;
  });

  // Edits the database keeps are written through as they are made.
  const current = useRef(state);
  current.current = state;
  const send = useCallback<Dispatch<Action>>((action) => {
    const before = current.current;
    dispatch(action);
    if (before.project !== null) persist(action, before, dispatch);
  }, []);

  // Another production or day opened (here or from another window).
  useEffect(() => {
    const project = state.project ? projectApi() : null;
    if (!project) return undefined;
    return project.onChange((next) => dispatch({ type: 'projectState', project: next }));
  }, [state.project !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // The media engine: its state now and every change after.
  useEffect(() => {
    const media = state.engine ? engine() : null;
    if (!media) return undefined;
    let live = true;
    const stop = media.onChange((next) => dispatch({ type: 'engineState', media: next }));
    void media.state().then((next) => live && dispatch({ type: 'engineState', media: next }));
    return () => {
      live = false;
      stop();
    };
  }, [state.engine]);

  // The engine's stand-in in the preview: progress every half second.
  useEffect(() => {
    if (!simulate || state.engine) return undefined;
    const timer = setInterval(() => dispatch({ type: 'tick' }), 500);
    return () => clearInterval(timer);
  }, [simulate, state.engine]);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, state.theme);
    } catch {
      // Private storage unavailable: the choice lasts this session.
    }
  }, [state.theme]);

  return <StoreContext.Provider value={{ state, dispatch: send }}>{children}</StoreContext.Provider>;
}

export const useStore = () => {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore outside StoreProvider');
  return store;
};
