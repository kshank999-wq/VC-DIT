import { jobProgress, jobState, legProgress, legState, legWord, type JobState } from '../model/status';
import type { Status, TransferJob, TransferLeg } from '../model/types';
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
  // Problems first, then what is moving, then the queue, then the finished cards.
  const jobs = state.jobs.map((job, index) => ({ job, index })).sort((a, b) => ORDER[jobState(a.job)] - ORDER[jobState(b.job)] || a.index - b.index);
  const count = (which: JobState) => state.jobs.filter((job) => jobState(job) === which).length;
  const problems = count('problem');
  const running = count('running');
  const waiting = count('waiting');
  const summary = [
    `${count('safe')} of ${state.jobs.length} cards safe to format`,
    problems ? `${problems} problem${problems === 1 ? '' : 's'}` : null,
    running ? `${running} copying or checking` : null,
    waiting ? `${waiting} waiting` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="screen">
      <ScreenHeader
        step="verify"
        eyebrow="02 · Verify"
        title="Copy & verification"
        description="Each card is copied, then checked. It's safe to format only when every destination says Verified."
        actions={
          <button type="button" className="btn" title="Writes ASC MHL + CSV to 08_REPORTS">
            Export transfer logs
          </button>
        }
      />

      <p className="verify-summary" style={{ color: problems ? statusVar('problem') : undefined }} aria-live="polite">
        {summary}
      </p>

      {jobs.map(({ job }) => {
        const head = pill(job);
        return (
          <section key={job.id} className={`card verify-card${head.status === 'problem' ? ' problem' : ''}`} aria-label={`Card ${job.id}`}>
            <div className="verify-head">
              <span className="mono verify-id">{job.id}</span>
              <span className="muted">
                {job.label} · {job.size}
              </span>
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
                      <span className="verify-word" style={{ color: statusVar(status) }}>
                        {legWord(leg)}
                      </span>
                    </div>
                    <ProgressBar pct={leg.failed ? 100 : legProgress(leg)} color={statusVar(status === 'idle' ? 'working' : status)} label={`${job.id} to ${leg.name}`} />
                    {leg.failed ? (
                      <div className="row">
                        <button type="button" className="btn danger small" aria-label={`Retry copy ${job.id} → ${leg.name}`} onClick={() => dispatch({ type: 'retryLeg', job: job.id, leg: leg.name })}>
                          Retry copy
                        </button>
                        <span className="muted verify-why">Checksum mismatch — copy again from the card.</span>
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
