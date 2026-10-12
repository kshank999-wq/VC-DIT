import { jobProgress, jobState, legProgress, legState, legWord, type JobState } from '../model/status';
import type { FormatRule } from '../../shared/project';
import type { Status, TransferJob, TransferLeg } from '../model/types';
import { engine, formatEta, formatRate } from '../state/engine';
import { useStore } from '../state/store';
import { UploadControls } from '../ui/UploadControls';
import { EjectAllButton } from '../ui/EjectAll';
import { ClearCardDialog, clearedWord, EjectButton, volumeOfJob } from '../ui/ClearCard';
import { useState } from 'react';
import { Pill, ProgressBar, ScreenHeader, statusVar } from '../ui/kit';
import './ingest.css';

/**
 * Verify: every card's copy to every destination, and the one thing the
 * DIT needs to know about each card: can it be formatted. Spec rules: "Safe
 * to format" only when every destination is verified, never while one has
 * failed (§4.3, §8). VC DIT never formats a card; it clears one for camera
 * only after a fresh check and two confirmations (see ui/ClearCard.tsx).
 */

const ORDER: Record<JobState, number> = { problem: 0, running: 1, waiting: 2, eject: 3, safe: 4 };

const pill = (job: TransferJob, rule: FormatRule): { status: Status; word: string } => {
  switch (jobState(job, rule)) {
    case 'safe':
      return { status: 'done', word: 'Safe to format' };
    case 'eject': {
      const local = job.legs.filter((leg) => !leg.relay).length;
      return { status: 'needs', word: rule === 'two-local' && local < 2 ? "Can come out · only one local copy — don't format" : "Can come out · don't format until the upload verifies" };
    }
    case 'problem':
      return { status: 'problem', word: "Problem — don't format" };
    case 'running':
      return { status: 'working', word: `Not safe yet · ${jobProgress(job)}%` };
    default:
      return { status: 'idle', word: 'Waiting' };
  }
};

const legStatus = (leg: TransferLeg): Status => {
  const state = legState(leg);
  return state === 'verified' ? 'done' : state === 'failed' ? 'problem' : state === 'waiting' ? 'idle' : 'working';
};

const RULE_WORD: Record<FormatRule, string> = {
  'two-local': 'two verified local copies',
  every: 'every destination verified, uploads included',
};

export function Verify() {
  const { state, dispatch } = useStore();
  const media = state.engine ? engine() : null;
  const retry = (job: TransferJob, leg: TransferLeg) => {
    if (media) void media.retry(job.id, leg.id ?? leg.name);
    else dispatch({ type: 'retryLeg', job: job.id, leg: leg.name });
  };
  // Problems first, then what is moving, then the queue, then the finished cards.
  const rule = state.production.formatRule;
  const [clearing, setClearing] = useState<TransferJob | null>(null);
  const jobs = state.jobs.map((job, index) => ({ job, index })).sort((a, b) => ORDER[jobState(a.job, rule)] - ORDER[jobState(b.job, rule)] || a.index - b.index);
  const count = (which: JobState) => state.jobs.filter((job) => jobState(job, rule) === which).length;
  const uploads = state.jobs.flatMap((job) => job.legs.filter((leg) => leg.relay));
  const uploading = uploads.filter((leg) => !leg.failed && legState(leg) !== 'verified').length;
  const problems = count('problem');
  const running = count('running');
  const waiting = count('waiting');
  const rest = [running ? `${running} copying or checking` : null, waiting ? `${waiting} waiting` : null].filter(Boolean);

  return (
    <div className="screen">
      <ScreenHeader
        step="verify"
        eyebrow="02 · Verify"
        title="Copy & verification"
        description={
          media
            ? "Each card is copied, then checked. It's safe to format only when the copies it relies on say Verified, and never while one has failed. Each destination gets an ASC MHL and a transfer log (REPORTS/ingest_verification)."
            : "Each card is copied, then checked. It's safe to format only when the copies it relies on say Verified, and never while one has failed."
        }
        actions={
          <>
            {media ? (
              uploads.length ? <UploadControls /> : null
            ) : (
              <button type="button" className="btn" title="Writes ASC MHL + CSV to 08_REPORTS">
                Export transfer logs
              </button>
            )}
            <EjectAllButton />
          </>
        }
      />

      {state.jobs.length === 0 ? (
        <p className="muted" role="status">
          No transfers yet. Start one from Intake.
        </p>
      ) : null}

      <p className="verify-summary" aria-live="polite">
        {count('safe')} of {state.jobs.length} cards safe to format
        {problems ? <span className="bad"> · {problems} problem{problems === 1 ? '' : 's'} — don't format {problems === 1 ? 'it' : 'them'}</span> : null}
        {rest.length ? ` · ${rest.join(' · ')}` : null}
        {uploading ? ` · ${uploading} upload${uploading === 1 ? '' : 's'} ${state.relaysPaused ? 'paused' : 'not finished'}` : null}
      </p>
      <p className="muted small">Safe to format means {RULE_WORD[rule]}. Change it in Project setup.</p>

      {jobs.map(({ job }) => {
        const head = pill(job, rule);
        return (
          <section key={job.id} className={`card verify-card${head.status === 'problem' ? ' problem' : ''}`} aria-label={`Card ${job.id}`}>
            <div className="verify-head">
              <span className="mono verify-id">{job.id}</span>
              <span className="muted">
                {job.label} · {job.size}
                {media ? ` · ${job.files}` : ''}
              </span>
              {job.bytesPerSecond ? (
                <span className="mono muted verify-rate">
                  {formatRate(job.bytesPerSecond)}
                  {job.etaSeconds != null ? ` · ${formatEta(job.etaSeconds)}` : ''}
                </span>
              ) : null}
              <span className="mono faint verify-sum" title="Checksum used for this card">
                {job.checksum}
              </span>
              <span className="grow" />
              {job.clearedAt ? (
                <>
                  <span className="muted small">{clearedWord(job)}</span>
                  {volumeOfJob(state, job) ? <EjectButton volume={volumeOfJob(state, job)!} /> : null}
                </>
              ) : head.status === 'done' && volumeOfJob(state, job) ? (
                <button type="button" className="btn small" onClick={() => setClearing(job)}>
                  Clear card…
                </button>
              ) : null}
              <Pill status={head.status}>{head.word}</Pill>
            </div>
            <div className="verify-legs">
              {job.legs.map((leg) => {
                const status = legStatus(leg);
                return (
                  <div key={leg.name} className="verify-leg">
                    <div className="row">
                      <span className="mono muted grow">
                        {leg.relay ? `↑ ${leg.name}` : `→ ${leg.name}`}
                        {leg.relay ? <span className="faint"> · upload{leg.relayFrom ? ` from ${leg.relayFrom}` : ' from the backup'}</span> : null}
                      </span>
                      {media && leg.targetDir && legState(leg) === 'verified' ? (
                        <button type="button" className="btn ghost small" onClick={() => void media.show(leg.targetDir!)}>
                          Show
                        </button>
                      ) : null}
                      <span className="verify-word" style={{ color: statusVar(status) }}>
                        {legWord(leg)}
                      </span>
                    </div>
                    <ProgressBar pct={leg.failed ? 100 : legProgress(leg)} color={statusVar(status === 'idle' ? 'working' : status)} label={`${job.id} to ${leg.name}`} />
                    {leg.failed ? (
                      <div className="row">
                        <button type="button" className="btn danger small" aria-label={`Retry ${leg.relay ? 'upload' : 'copy'} ${job.id} → ${leg.name}`} onClick={() => retry(job, leg)}>
                          {leg.relay ? 'Retry upload' : 'Retry copy'}
                        </button>
                        <span className="muted verify-why">{leg.error ?? 'Checksum mismatch — copy again from the card.'}</span>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {clearing ? <ClearCardDialog job={clearing} onClose={() => setClearing(null)} /> : null}
    </div>
  );
}
