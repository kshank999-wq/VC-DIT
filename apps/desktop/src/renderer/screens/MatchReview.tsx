import type { MatchItem, Status } from '../model/types';
import { useStore } from '../state/store';
import { Chip, Frame, ProgressBar, ScreenHeader, StatusText, statusVar, tone } from '../ui/kit';
import './organize.css';

/**
 * Match Review: script-log entries the matcher could not tie to media with
 * confidence. The DIT picks a candidate or marks the take unslated / wild;
 * confirming moves straight on to the next open item.
 *
 * Spec §4.5: never auto-accept a match below 90% confidence. Everything
 * listed here waits for a person.
 */

const confidenceStatus = (pct: number): Status => (pct >= 90 ? 'done' : pct >= 50 ? 'needs' : 'problem');

const chipFor = (match: MatchItem): [string, Status] =>
  match.resolution === null ? ['Review', 'needs'] : match.resolution.kind === 'matched' ? ['Matched', 'done'] : ['Wild', 'working'];

export function MatchReview() {
  const { state, dispatch } = useStore();
  const open = state.matches.filter((match) => match.resolution === null).length;
  const match = state.matches.find((candidate) => candidate.id === state.selectedMatch) ?? state.matches[0];

  return (
    <div className="screen">
      <ScreenHeader
        step="organize"
        eyebrow="03 · Organize · Match review"
        title={open > 0 ? `${open} item${open === 1 ? '' : 's'} need${open === 1 ? 's' : ''} a decision` : 'All matched'}
        description="Low-confidence matches between the script log and media. VC DIT never auto-accepts below 90% — you decide."
      />

      {match ? (
        <div className="match-layout">
          <div className="match-list" role="group" aria-label="Log entries to review">
            {state.matches.map((item) => {
              const [word, status] = chipFor(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  className="match-item"
                  aria-pressed={item.id === match.id}
                  onClick={() => dispatch({ type: 'selectMatch', id: item.id })}
                >
                  <span className="row">
                    <span className="mono grow">{item.log}</span>
                    <Chip color={statusVar(status)}>{word}</Chip>
                  </span>
                  <span className="muted">{item.reason}</span>
                </button>
              );
            })}
          </div>

          <div className="card match-detail">
            <div className="match-top">
              <div>
                <span className="label">Script log entry</span>
                {match.fields.map(([label, value]) => (
                  <div key={label} className="org-log-field">
                    <span className="muted">{label}</span>
                    <span className="mono">{value}</span>
                  </div>
                ))}
              </div>
              <div>
                <span className="label">Why it needs review</span>
                <p className="org-why">{match.reason}</p>
              </div>
            </div>

            <div className="org-cands" role="radiogroup" aria-label="Candidate media">
              <span className="label">Candidate media</span>
              {match.candidates.map((candidate, index) => {
                const picked = match.resolution === null ? index === match.picked : match.resolution.kind === 'matched' && match.resolution.clip === candidate.clip;
                const status = confidenceStatus(candidate.confidence);
                const locked = match.resolution !== null;
                return (
                  <label key={candidate.clip} className={`org-cand${picked ? ' is-picked' : ''}${locked ? ' is-locked' : ''}`}>
                    <input
                      type="radio"
                      name={`candidate-${match.id}`}
                      checked={picked}
                      disabled={locked}
                      onChange={() => dispatch({ type: 'pickCandidate', id: match.id, index })}
                      aria-label={`${candidate.clip}, ${candidate.confidence}% confidence`}
                    />
                    <Frame label="frame" style={{ height: 56, borderRadius: 4 }} />
                    <span className="stack" style={{ gap: 4 }}>
                      <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                        {candidate.clip}
                      </span>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {candidate.why}
                      </span>
                    </span>
                    <span className="mono">{candidate.tc}</span>
                    <span className="org-conf" style={tone(statusVar(status))}>
                      <ProgressBar pct={candidate.confidence} color={statusVar(status)} label={`${candidate.clip} confidence`} />
                      <span className="org-pct">{candidate.confidence}%</span>
                    </span>
                  </label>
                );
              })}

              {match.resolution === null ? (
                <div className="match-actions">
                  <button type="button" className="btn" style={{ height: 34 }} onClick={() => dispatch({ type: 'markWild', id: match.id })}>
                    Mark unslated / wild
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    style={{ height: 34 }}
                    disabled={!match.candidates[match.picked]}
                    onClick={() => dispatch({ type: 'confirmMatch', id: match.id })}
                  >
                    Confirm match
                  </button>
                </div>
              ) : (
                <div className="match-outcome" style={tone(statusVar(match.resolution.kind === 'matched' ? 'done' : 'working'))}>
                  <StatusText status={match.resolution.kind === 'matched' ? 'done' : 'working'} word={match.resolution.kind === 'matched' ? 'Matched' : 'Wild'} />
                  <span className="muted">
                    {match.resolution.kind === 'matched'
                      ? `${match.log} is linked to ${match.resolution.clip}. You confirmed it.`
                      : `${match.log} is marked unslated / wild — no clip is linked. The media is still kept.`}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <p className="muted">The script log has nothing waiting for review.</p>
      )}
    </div>
  );
}
