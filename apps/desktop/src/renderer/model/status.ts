import type { AppState } from '../state/store';
import type { ScreenId, Status, StepId, TransferJob, TransferLeg } from './types';

/**
 * Everything the app says about how the day is going, derived from state in
 * one place. The header pill, the flow bar, the file tree's dots, Today's
 * tiles and its to-do list all read these, so a failed check turns all of
 * them red together and nothing can show green while a copy has failed
 * (spec §8).
 */

export const STEPS: { id: StepId; number: number; name: string; screen: ScreenId; screens: ScreenId[] }[] = [
  { id: 'intake', number: 1, name: 'Intake', screen: 'intake', screens: ['intake'] },
  { id: 'verify', number: 2, name: 'Verify', screen: 'verify', screens: ['verify'] },
  { id: 'organize', number: 3, name: 'Organize', screen: 'scenes', screens: ['scenes', 'match'] },
  { id: 'vfx', number: 4, name: 'VFX', screen: 'vfx', screens: ['vfx'] },
  { id: 'sync', number: 5, name: 'Audio Sync', screen: 'sync', screens: ['sync'] },
  { id: 'output', number: 6, name: 'Output', screen: 'dailies', screens: ['looks', 'dailies', 'delivery'] },
];

export const stepOfScreen = (screen: ScreenId): StepId | null => STEPS.find((step) => step.screens.includes(screen))?.id ?? null;

export const STATUS_WORD: Record<Status, string> = {
  done: 'Done',
  working: 'Working',
  needs: 'Needs you',
  problem: 'Problem',
  idle: 'Not started',
};

/** Worst first: what decides an overall colour. */
const RANK: Record<Status, number> = { problem: 4, needs: 3, working: 2, idle: 1, done: 0 };
export const worst = (statuses: Status[]): Status => statuses.reduce<Status>((a, b) => (RANK[b] > RANK[a] ? b : a), 'done');

// ---------------------------------------------------------------- transfers

export const legState = (leg: TransferLeg): 'failed' | 'verified' | 'checking' | 'copying' | 'waiting' => {
  if (leg.failed) return 'failed';
  if (leg.copyPct >= 100 && leg.verifyPct >= 100) return 'verified';
  if (leg.copyPct >= 100) return 'checking';
  if (leg.copyPct > 0) return 'copying';
  return 'waiting';
};

export const legWord = (leg: TransferLeg): string => {
  switch (legState(leg)) {
    case 'failed':
      return 'Failed';
    case 'verified':
      return 'Verified';
    case 'checking':
      return `Checking ${Math.floor(leg.verifyPct)}%`;
    case 'copying':
      return `Copying ${Math.floor(leg.copyPct)}%`;
    default:
      return 'Waiting';
  }
};

/** Copy and read-back together, as one bar: half each. */
export const legProgress = (leg: TransferLeg): number => (leg.copyPct + leg.verifyPct) / 2;

export type JobState = 'safe' | 'problem' | 'running' | 'waiting';

/** "Safe to format" only when every destination verified; never when one failed (spec §4.3, §8). */
export const jobState = (job: TransferJob): JobState => {
  if (job.legs.some((leg) => leg.failed)) return 'problem';
  if (job.legs.every((leg) => legState(leg) === 'verified')) return 'safe';
  if (job.queued || job.legs.every((leg) => legState(leg) === 'waiting')) return 'waiting';
  return 'running';
};

export const jobProgress = (job: TransferJob): number => Math.floor(job.legs.reduce((sum, leg) => sum + legProgress(leg), 0) / job.legs.length);

// ---------------------------------------------------------------- the steps

export interface StepSummary {
  id: StepId;
  status: Status;
  /** One line under the step name: "4/5 verified". */
  metric: string;
  /** Today's tile: a sentence about it. */
  detail: string;
  /** The status word, specific where it helps ("New media", "Ready"). */
  word: string;
}

const pendingSources = (state: AppState) =>
  state.volumes.filter((volume) => (volume.role === 'Camera' || volume.role === 'Sound') && !volume.ingested);

export const summarize = (state: AppState): Record<StepId, StepSummary> => {
  const jobs = state.jobs.map(jobState);
  const safe = jobs.filter((job) => job === 'safe').length;
  const failed = jobs.filter((job) => job === 'problem').length;
  const running = jobs.filter((job) => job === 'running').length;

  const fresh = pendingSources(state).length;
  const intake: StepSummary = {
    id: 'intake',
    status: fresh > 0 ? 'needs' : 'done',
    metric: `${state.jobs.length} cards in`,
    detail: fresh > 0 ? `${fresh} new card${fresh === 1 ? '' : 's'} mounted` : 'Every mounted card is queued',
    word: fresh > 0 ? 'New media' : 'Done',
  };

  const verify: StepSummary = {
    id: 'verify',
    status: failed > 0 ? 'problem' : running > 0 || jobs.includes('waiting') ? 'working' : 'done',
    metric: `${safe}/${state.jobs.length} verified`,
    detail: failed > 0 ? `${failed} card${failed === 1 ? '' : 's'} failed ${failed === 1 ? 'its' : 'their'} check` : running > 0 ? `${running} copying or checking` : 'Every card safe to format',
    word: failed > 0 ? 'Problem' : running > 0 ? 'Working' : 'Done',
  };

  const open = state.matches.filter((match) => match.resolution === null).length;
  const entries = state.scriptLog.entries;
  const organize: StepSummary = {
    id: 'organize',
    status: open > 0 ? 'needs' : 'done',
    metric: `${entries - open}/${entries} matched`,
    detail: open > 0 ? `${open} match${open === 1 ? '' : 'es'} to confirm` : 'Every log entry matched',
    word: open > 0 ? 'Needs you' : 'Done',
  };

  const sent = state.vfx.filter((shot) => shot.prep === 'sent').length;
  const blocked = state.vfx.filter((shot) => shot.prep === 'blocked').length;
  const vfx: StepSummary = {
    id: 'vfx',
    status: sent === state.vfx.length ? 'done' : 'idle',
    metric: `${state.vfx.length} shots mirrored`,
    detail: sent === state.vfx.length ? 'Sent to VC VFX Prep' : blocked > 0 ? `Ready to send · ${blocked} waiting on a match` : 'Ready to send to prep',
    word: sent === state.vfx.length ? 'Sent' : 'Ready',
  };

  const synced = state.sync.filter((item) => item.accepted).length;
  const sync: StepSummary = {
    id: 'sync',
    status: synced === state.sync.length ? 'done' : 'needs',
    metric: `${synced}/${state.sync.length} synced`,
    detail: synced === state.sync.length ? 'Every take in sync' : `${state.sync.length - synced} take${state.sync.length - synced === 1 ? '' : 's'} to check`,
    word: synced === state.sync.length ? 'Done' : 'Needs you',
  };

  const delivered = state.delivered.length;
  const output: StepSummary = {
    id: 'output',
    status: delivered > 0 ? 'done' : state.dailies.built ? 'working' : 'idle',
    metric: `${delivered}/${state.packages.filter((pkg) => pkg.selected).length || 3} delivered`,
    detail: delivered > 0 ? 'Delivered and verified' : state.dailies.built ? 'Dailies built · deliver when ready' : 'Dailies, editorial & archive',
    word: delivered > 0 ? 'Delivered' : state.dailies.built ? 'Dailies built' : 'Not started',
  };

  return { intake, verify, organize, vfx, sync, output };
};

// ---------------------------------------------------------------- overall

export interface Overall {
  status: Status;
  /** "1 problem · 2 to check". */
  label: string;
  /** Today's headline. */
  headline: string;
  /** Where clicking the pill goes: the most urgent screen. */
  screen: ScreenId;
}

export const overall = (state: AppState, steps = summarize(state)): Overall => {
  const list = STEPS.map((step) => ({ step, summary: steps[step.id] }));
  const problems = list.filter((item) => item.summary.status === 'problem');
  const needs = list.filter((item) => item.summary.status === 'needs');
  const failedCards = state.jobs.filter((job) => jobState(job) === 'problem').length;
  if (problems.length > 0) {
    return {
      status: 'problem',
      label: `${failedCards || problems.length} problem${(failedCards || problems.length) === 1 ? '' : 's'}${needs.length ? ` · ${needs.length} to check` : ''}`,
      headline: failedCards === 1 ? '1 card failed its check — fix that first.' : `${failedCards} cards failed their check — fix those first.`,
      screen: problems[0]!.step.screen,
    };
  }
  if (needs.length > 0) {
    return {
      status: 'needs',
      label: `${needs.length} thing${needs.length === 1 ? '' : 's'} need${needs.length === 1 ? 's' : ''} you`,
      headline: `${needs.length} thing${needs.length === 1 ? ' needs' : 's need'} you.`,
      screen: needs[0]!.step.id === 'organize' ? 'match' : needs[0]!.step.screen,
    };
  }
  return { status: 'done', label: 'All good', headline: 'All good. Everything is verified and in place.', screen: 'today' };
};

// ---------------------------------------------------------------- to-do

export interface Todo {
  id: string;
  status: Status;
  title: string;
  detail: string;
  step: StepId;
  action: string;
  screen: ScreenId;
  /** A failed copy can be retried right from Today. */
  retry?: { job: string; leg: string };
}

export const todos = (state: AppState): Todo[] => {
  const out: Todo[] = [];
  for (const job of state.jobs) {
    for (const leg of job.legs.filter((candidate) => candidate.failed)) {
      out.push({
        id: `retry-${job.id}-${leg.name}`,
        status: 'problem',
        title: `${job.id} → ${leg.name} checksum mismatch`,
        detail: 'Files failed verification. Card is not safe to format.',
        step: 'verify',
        action: 'Retry',
        screen: 'verify',
        retry: { job: job.id, leg: leg.name },
      });
    }
  }
  const fresh = pendingSources(state);
  if (fresh.length > 0) {
    out.push({
      id: 'ingest',
      status: 'needs',
      title: `${fresh.length} new card${fresh.length === 1 ? '' : 's'} to ingest`,
      detail: fresh.map((volume) => volume.name).join(', '),
      step: 'intake',
      action: 'Ingest',
      screen: 'intake',
    });
  }
  const open = state.matches.filter((match) => match.resolution === null);
  if (open.length > 0) {
    out.push({
      id: 'match',
      status: 'needs',
      title: `${open.length} script-log entr${open.length === 1 ? 'y needs' : 'ies need'} review`,
      detail: `Low-confidence matches in ${[...new Set(open.map((match) => match.log.split(' / ')[0]))].join(' and ')}.`,
      step: 'organize',
      action: 'Review',
      screen: 'match',
    });
  }
  const unsynced = state.sync.filter((item) => !item.accepted);
  if (unsynced.length > 0) {
    out.push({
      id: 'sync',
      status: 'needs',
      title: `${unsynced.length} take${unsynced.length === 1 ? ' needs' : 's need'} sync review`,
      detail: [...new Set(unsynced.map((item) => (item.confidence === 0 ? 'missing timecode' : `${item.method.toLowerCase()} match`)))].join(' / '),
      step: 'sync',
      action: 'Open',
      screen: 'sync',
    });
  }
  if (!state.dailies.built) {
    out.push({
      id: 'dailies',
      status: 'idle',
      title: "Build today's dailies",
      detail: 'Circle takes are synced and ready for review.',
      step: 'output',
      action: 'Build',
      screen: 'dailies',
    });
  }
  return out;
};

// ---------------------------------------------------------------- formatting

export const formatGb = (gb: number): string => {
  if (!Number.isFinite(gb)) return '∞';
  if (gb >= 1000) return `${(gb / 1000).toFixed(2)} TB`;
  if (gb < 1) return `${Math.round(gb * 1000)} MB`;
  return `${Math.round(gb)} GB`;
};

/** SMPTE-style clock for the header: HH:MM:SS:FF at the production's frame rate. */
export const timecodeNow = (date: Date, fps = 24): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}:${pad(Math.floor((date.getMilliseconds() / 1000) * fps))}`;
};
