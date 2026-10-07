import { DESTINATION_ROLES, SOURCE_ROLES, formatBytes, type IngestRequest, type MediaState } from '../../shared/media';
import { DELIVERY_PACKAGES, packageBytes, type DailiesSettings, type DeliveryState, type ProjectState } from '../../shared/project';
import type { IngestDestination, TransferJob, Volume } from '../model/types';
import type { Dispatch } from 'react';
import type { Action, AppState } from './store';

/**
 * The desktop app's two back ends as the screens see them:
 *
 * - the media engine: its volumes, destination folders and transfers, turned
 *   into the records the UI already shows. The ticks the operator sets
 *   (which cards go in, which destinations are written) stay in the UI and
 *   survive each update from the engine;
 * - the production database: settings, shoot days and scene lists. Edits
 *   apply in the UI at once and are written through (`persist`).
 */

export const engine = (): MediaApi | null => (typeof window !== 'undefined' ? (window.vcdit?.media ?? null) : null);
export const projectApi = (): ProjectApi | null => (typeof window !== 'undefined' ? (window.vcdit?.project ?? null) : null);

type FromProject = Pick<
  AppState,
  | 'production'
  | 'day'
  | 'scenes'
  | 'project'
  | 'checksum'
  | 'matches'
  | 'vfx'
  | 'scriptLog'
  | 'selectedSetup'
  | 'selectedMatch'
  | 'mirrorMethod'
  | 'vfxActivity'
  | 'sync'
  | 'selectedSync'
  | 'syncActivity'
  | 'luts'
  | 'lutRules'
  | 'selectedLut'
  | 'dailies'
  | 'previewClips'
  | 'renders'
  | 'dailiesActivity'
  | 'ffmpeg'
  | 'delivery'
  | 'packages'
  | 'deliveryDestinations'
  | 'delivered'
>;

/** Packages with a record today and nothing left unverified: what the Output step counts as delivered. */
const deliveredPackages = (delivery: DeliveryState): string[] =>
  DELIVERY_PACKAGES.filter((pkg) => {
    const mine = delivery.records.filter((record) => record.package === pkg.id);
    return mine.length > 0 && mine.every((record) => record.failed === 0);
  }).map((pkg) => pkg.id);

/** The production as the database has it, into the UI's state. */
export const fromProject = (state: AppState, project: ProjectState): FromProject => {
  const scenes = project.scenes;
  const [sceneId, setupId] = state.selectedSetup.split('|');
  const selectedStillThere = scenes.some((scene) => scene.id === sceneId && scene.setups.some((setup) => setup.id === setupId));
  const firstSetup = scenes.find((scene) => scene.setups.length > 0);
  const vfx = project.vfx.map((shot) => ({
    key: shot.key,
    scene: shot.scene,
    setup: shot.setup,
    take: shot.take,
    clip: shot.clip,
    note: shot.note,
    flaggedBy: shot.flaggedBy,
    prep: shot.sentAt ? ('sent' as const) : shot.matched ? ('eligible' as const) : ('blocked' as const),
    locations: shot.locations,
  }));
  return {
    production: project.production,
    day: project.day,
    scenes,
    project: { file: project.file, days: project.days, recent: project.recent },
    // A different production brings its own checksum default.
    checksum: state.project?.file === project.file ? state.checksum : project.production.checksum,
    matches: project.matches,
    selectedMatch: project.matches.some((match) => match.id === state.selectedMatch)
      ? state.selectedMatch
      : (project.matches.find((match) => !match.resolution)?.id ?? project.matches[0]?.id ?? ''),
    vfx,
    mirrorMethod: project.production.vfxMethod,
    vfxActivity: project.vfxActivity,
    sync: project.sync,
    // Stay on the clip being looked at, wherever it moves in the list.
    selectedSync: Math.max(0, project.sync.findIndex((item) => item.id === state.sync[state.selectedSync]?.id)),
    syncActivity: project.syncActivity,
    luts: project.luts.map((lut) => ({
      id: lut.id,
      name: lut.name,
      description: [lut.title, `${lut.kind} · ${lut.size}-point ${lut.format}`].filter(Boolean).join(' · '),
      isDefault: lut.isDefault,
    })),
    lutRules: project.lutRules,
    selectedLut: Math.max(0, Math.min(state.selectedLut, project.luts.length - 1)),
    dailies: { ...project.dailies, built: project.renders.some((render) => render.state === 'done') },
    previewClips: project.previewClips,
    renders: project.renders,
    dailiesActivity: project.dailiesActivity,
    ffmpeg: project.ffmpeg,
    delivery: project.delivery,
    packages: DELIVERY_PACKAGES.map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      description: pkg.description,
      gb: packageBytes(project.delivery, pkg.id).bytes / 1e9,
      selected: project.delivery.settings.packages.includes(pkg.id),
    })),
    deliveryDestinations: project.delivery.places.map((place) => ({
      id: place.id,
      name: place.name,
      kind: place.kind,
      freeGb: (place.freeBytes ?? 0) / 1e9,
      selected: project.delivery.settings.destinations.includes(place.id),
    })),
    delivered: deliveredPackages(project.delivery),
    scriptLog: project.log
      ? {
          file: project.log.file,
          importedAt: project.log.importedAt,
          entries: project.log.entries,
          vfxFlags: project.log.vfxFlags,
          format: project.log.format,
          warnings: project.log.warnings,
        }
      : { file: '', importedAt: '', entries: 0, vfxFlags: 0 },
    selectedSetup: selectedStillThere || !firstSetup ? state.selectedSetup : `${firstSetup.id}|${firstSetup.setups[0]!.id}`,
  };
};

/**
 * Write an edit through to the production database. Only edits the database
 * keeps; the rest is UI state. `before` is the state the action was applied
 * to. A match decision comes back with the day re-derived (the take's status
 * changes), so its answer is applied.
 */
export const persist = (action: Action, before: AppState, dispatch: Dispatch<Action>): void => {
  const api = projectApi();
  if (!api) return;
  const apply = (call: Promise<{ ok: true; state: ProjectState } | { ok: false; reason: string }>) =>
    void call.then((result) => result.ok && dispatch({ type: 'projectState', project: result.state }));
  switch (action.type) {
    case 'confirmMatch': {
      const match = before.matches.find((candidate) => candidate.id === action.id);
      const clip = match?.candidates[match.picked]?.clip;
      if (clip) apply(api.resolveMatch(action.id, clip));
      return;
    }
    case 'markWild':
      apply(api.resolveMatch(action.id, null));
      return;
    case 'nudgeSync': {
      const item = before.sync[before.selectedSync];
      if (item?.id) apply(api.syncNudge(item.id, action.frames));
      return;
    }
    case 'acceptSync': {
      const item = before.sync[before.selectedSync];
      if (item?.id) apply(api.syncAccept([item.id]));
      return;
    }
    case 'batchSync': {
      const ids = before.sync.filter((item) => item.take.startsWith(action.scene) && item.confidence >= 90 && !item.accepted && item.id).map((item) => item.id!);
      if (ids.length) apply(api.syncAccept(ids));
      return;
    }
    case 'waveformPass':
      apply(api.syncWaveform());
      return;
    case 'setDailies':
      void api.saveDailies(dailiesSettings({ ...before.dailies, ...action.patch }));
      return;
    case 'toggleBurnIn':
      void api.saveDailies(dailiesSettings({ ...before.dailies, burnIns: { ...before.dailies.burnIns, [action.key]: !before.dailies.burnIns[action.key] } }));
      return;
    case 'togglePackage':
    case 'toggleDeliveryDestination':
    case 'setDeliveryChoice': {
      if (!before.delivery) return;
      const { packages, destinations } = before.delivery.settings;
      if (action.type === 'setDeliveryChoice') void api.saveDelivery({ packages: action.packages, destinations: action.destinations });
      else if (action.type === 'togglePackage') {
        const id = action.id as (typeof packages)[number];
        void api.saveDelivery({ packages: packages.includes(id) ? packages.filter((pkg) => pkg !== id) : [...packages, id] });
      } else void api.saveDelivery({ destinations: destinations.includes(action.id) ? destinations.filter((id) => id !== action.id) : [...destinations, action.id] });
      return;
    }
    case 'setProduction':
      void api.update(action.patch);
      return;
    case 'setMirrorMethod':
      void api.update({ vfxMethod: action.method });
      return;
    case 'setDay':
      void api.updateDay(action.patch);
      return;
    case 'setSceneStatus':
      void api.updateScene(action.scene, { status: action.status });
      return;
    case 'addScene':
      void api.addScene({ id: action.id, description: action.description.trim() || 'Added on the day' });
      return;
    case 'removeScene':
      void api.removeScene(action.scene);
      return;
    default:
      return;
  }
};

/** The screen's dailies choices as the settings the database keeps. */
export const dailiesSettings = (options: AppState['dailies']): DailiesSettings => ({
  include: options.include,
  scenes: options.scenes ?? [],
  codec: options.codec,
  resolution: options.resolution,
  audio: options.audio,
  look: options.look as DailiesSettings['look'],
  grouping: options.grouping as DailiesSettings['grouping'],
  destination: options.destination,
  burnIns: options.burnIns,
});

const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : 0);

export const fromEngine = (state: AppState, media: MediaState): Pick<AppState, 'volumes' | 'destinations' | 'jobs'> => {
  const volumes = media.volumes.map<Volume>((volume) => {
    const before = state.volumes.find((candidate) => candidate.id === volume.id);
    const used = Math.max(0, volume.totalBytes - volume.freeBytes);
    return {
      id: volume.id,
      name: volume.name,
      media: `${volume.kind} · ${formatBytes(volume.totalBytes)}`,
      filesystem: volume.filesystem,
      used: formatBytes(used),
      fillPct: pct(used, volume.totalBytes),
      detected: volume.detected,
      role: volume.role,
      // New cards come ticked, as do volumes already marked to receive copies.
      included:
        before && before.role === volume.role
          ? before.included && !(SOURCE_ROLES.includes(volume.role) && volume.ingested)
          : SOURCE_ROLES.includes(volume.role)
            ? !volume.ingested
            : DESTINATION_ROLES.includes(volume.role),
      ingested: volume.ingested,
      mountPath: volume.mountPath,
    };
  });
  const destinations = media.folders.map<IngestDestination>((folder) => {
    const before = state.destinations.find((candidate) => candidate.id === folder.id);
    return {
      id: folder.id,
      name: folder.name,
      kind: folder.online ? folder.path : `${folder.path} · not reachable`,
      free: folder.online ? formatBytes(folder.freeBytes) : '—',
      fillPct: pct(folder.totalBytes - folder.freeBytes, folder.totalBytes),
      selected: folder.online && (before?.selected ?? true),
    };
  });
  const jobs = media.jobs.map<TransferJob>((job) => ({
    id: job.id,
    label: job.label,
    size: formatBytes(job.totalBytes),
    files: `${job.fileCount.toLocaleString('en-US')} file${job.fileCount === 1 ? '' : 's'}`,
    queued: job.queued,
    checksum: job.checksum,
    legs: job.legs.map((leg) => ({
      id: leg.id,
      name: leg.name,
      copyPct: leg.copyPct,
      verifyPct: leg.verifyPct,
      failed: leg.failed,
      rate: 1,
      error: leg.error,
      targetDir: leg.targetDir,
    })),
    bytesPerSecond: job.bytesPerSecond,
    etaSeconds: job.etaSeconds,
  }));
  return { volumes, destinations, jobs };
};

/** What Intake asks the engine for: the ticked cards to the ticked destinations. */
export const ingestRequest = (state: AppState): IngestRequest => ({
  sources: state.volumes.filter((volume) => SOURCE_ROLES.includes(volume.role) && volume.included && !volume.ingested).map((volume) => volume.id),
  destinations: [
    ...state.volumes.filter((volume) => DESTINATION_ROLES.includes(volume.role) && volume.included).map((volume) => volume.id),
    ...state.destinations.filter((destination) => destination.selected).map((destination) => destination.id),
  ],
  checksum: state.checksum,
  production: { name: state.production.name, code: state.production.code },
  day: { number: state.day.number, date: state.day.date },
});

export const formatRate = (bytesPerSecond: number): string => `${formatBytes(bytesPerSecond)}/s`;

export const formatEta = (seconds: number): string => {
  if (seconds < 60) return 'under a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
};
