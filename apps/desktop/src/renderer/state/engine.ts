import { DESTINATION_ROLES, SOURCE_ROLES, formatBytes, type IngestRequest, type MediaState } from '../../shared/media';
import type { IngestDestination, TransferJob, Volume } from '../model/types';
import type { AppState } from './store';

/**
 * The media engine as the screens see it: its volumes, destination folders
 * and transfers, turned into the records the UI already shows. The ticks
 * the operator sets (which cards go in, which destinations are written)
 * stay in the UI and survive each update from the engine.
 */

export const engine = (): MediaApi | null => (typeof window !== 'undefined' ? window.vcdit?.media ?? null : null);

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
