import { jobProgress, jobState, legProgress, legState, legWord, type JobState } from '../model/status';
import type { Status, TransferJob, TransferLeg } from '../model/types';
import { engine, formatEta, formatRate } from '../state/engine';
import { useStore } from '../state/store';
import { Pill, ProgressBar, ScreenHeader, statusVar } from '../ui/kit';
import './ingest.css';

/**
 * Verify: every card's copy to every destination, and the one thing the
 * DIT needs to know about each card: can it be formatted. Spec rules: "Safe
 * to format" only when every destination is verified, never while one has
 * failed (§4.3, §8); V1 never offers to format or delete a card.
 */

const ORDER: Record<JobState, number> = { problem: 0, running: 1, waiting: 2, safe: 3 };

const pill = (job: TransferJob): { status: Status; word: string } => {
  switch (jobState(job)) {
    case 'safe':
      return { status: 'done', word: 'Safe to format' };
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

export function Verify() {
  const { state, dispatch } = useStore();
  const media = state.engine ? engine() : null;
  const retry = (job: TransferJob, leg: TransferLeg) => {
    if (media) void media.retry(job.id, leg.id ?? leg.name);
    else dispatch({ type: 'retryLeg', job: job.id, leg: leg.name });
  };
  // Problems first, then what is moving, then the queue, then the finished cards.
  const jobs = state.jobs.map((job, index) => ({ job, index })).sort((a, b) => ORDER[jobState(a.job)] - ORDER[jobState(b.job)] || a.index - b.index);
  const count = (which: JobState) => state.jobs.filter((job) => jobState(job) === which).length;
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
            ? "Each card is copied, then checked. It's safe to format only when every destination says Verified. Each destination gets an ASC MHL and a transfer log (REPORTS/ingest_verification)."
            : "Each card is copied, then checked. It's safe to format only when every destination says Verified."
        }
        actions={
          media ? null : (
            <button type="button" className="btn" title="Writes ASC MHL + CSV to 08_REPORTS">
              Export transfer logs
            </button>
          )
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
      </p>

      {jobs.map(({ job }) => {
        const head = pill(job);
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
              <Pill status={head.status}>{head.word}</Pill>
            </div>
            <div className="verify-legs">
              {job.legs.map((leg) => {
                const status = legStatus(leg);
                return (
                  <div key={leg.name} className="verify-leg">
                    <div className="row">
                      <span className="mono muted grow">→ {leg.name}</span>
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
                        <button type="button" className="btn danger small" aria-label={`Retry copy ${job.id} → ${leg.name}`} onClick={() => retry(job, leg)}>
                          Retry copy
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
    </div>
  );
}
