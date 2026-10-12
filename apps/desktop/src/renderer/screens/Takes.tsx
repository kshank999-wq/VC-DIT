import { useMemo, useState } from 'react';
import type { AssignedClip, AssignSource, CameraReportInput, CameraReportRow, ProjectResult, SlateInput } from '../../shared/project';
import { projectApi } from '../state/engine';
import { useStore } from '../state/store';
import { Check, ScreenHeader, StatusText, statusVar, tone } from '../ui/kit';
import './organize.css';

/**
 * Assign takes (spec §4.4, §4.5): where each camera clip of the day goes.
 * The script log, the camera report and the slate the sound recorder wrote
 * each say where a clip belongs; where they agree it is placed, where they
 * disagree Match Review decides, and the DIT can place any clip by hand
 * (one, or a run of clips numbered take by take). The camera report is
 * entered here card by card, or imported, and checked against the cards.
 *
 * Every assignment builds the scene and setup folders on every destination
 * holding the clip, uploads included, as links to the card copy.
 */

const SOURCE: Record<AssignSource, { word: string; color: string }> = {
  log: { word: 'Script log', color: 'var(--st-organize)' },
  report: { word: 'Camera report', color: 'var(--st-intake)' },
  sound: { word: 'Sound slate', color: 'var(--st-sync)' },
  manual: { word: 'You', color: 'var(--st-output)' },
};

type Filter = 'all' | 'unplaced' | 'disagree';
const slateText = (clip: { scene: string; setup: string; take: string }) =>
  clip.scene ? `Sc ${clip.scene} / ${clip.setup || '—'} / T${clip.take.padStart(2, '0')}` : '—';

export function Takes() {
  const { state, dispatch } = useStore();
  const api = state.project ? projectApi() : null;
  const { takes } = state;
  const [notice, setNotice] = useState<string | null>(null);
  const answer = (call: Promise<ProjectResult>) =>
    void call.then((result) => {
      if (result.ok) {
        dispatch({ type: 'projectState', project: result.state });
        setNotice(null);
      } else if (result.reason) setNotice(result.reason);
    });

  // ------------------------------------------------ the clips
  const [filter, setFilter] = useState<Filter>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [slate, setSlate] = useState<SlateInput>({ scene: '', setup: '', take: '1', circle: false });
  const [step, setStep] = useState(true);
  const id = (clip: { card: string; clip: string }) => `${clip.card}|${clip.clip}`;
  const shown = takes.clips.filter((clip) => (filter === 'unplaced' ? !clip.scene : filter === 'disagree' ? clip.conflict : true));
  const cards = [...new Set(takes.clips.map((clip) => clip.card))];
  const count = (test: (clip: AssignedClip) => boolean) => takes.clips.filter(test).length;
  const chosen = takes.clips.filter((clip) => picked.includes(id(clip)));
  const toggle = (clip: AssignedClip) => setPicked(picked.includes(id(clip)) ? picked.filter((other) => other !== id(clip)) : [...picked, id(clip)]);

  const assign = async () => {
    if (!slate.scene.trim() || !slate.take.trim()) {
      setNotice('A scene and a take are needed.');
      return;
    }
    const clips = chosen.map(({ card, clip }) => ({ card, clip }));
    if (!api) {
      dispatch({ type: 'assignTakes', clips, slate, step });
    } else if (step && clips.length > 1) {
      // A run of clips, one take each: 3, 4, 5…
      const first = Number(slate.take) || 1;
      for (const [index, clip] of clips.entries()) {
        const result = await api.assign([clip], { ...slate, take: String(first + index) });
        if (!result.ok) {
          setNotice(result.reason);
          return;
        }
        if (index === clips.length - 1) dispatch({ type: 'projectState', project: result.state });
      }
    } else answer(api.assign(clips, slate));
    setPicked([]);
    // Ready for the next run: the take after the last one.
    setSlate({ ...slate, take: String((Number(slate.take) || 1) + (step ? clips.length : 1)) });
  };
  const backToSources = () => {
    const clips = chosen.map(({ card, clip }) => ({ card, clip }));
    if (api) answer(api.assign(clips, null));
    else dispatch({ type: 'assignTakes', clips, slate: null });
    setPicked([]);
  };

  return (
    <div className="screen">
      <ScreenHeader
        step="organize"
        eyebrow="03 · Organize"
        title="Assign takes"
        description="Where each clip goes: the script log, the camera report and the sound slate place it when they agree; you decide where they don't, and can place any clip yourself. Every destination gets the same scene and setup folders."
        actions={
          <button type="button" className="btn" onClick={() => dispatch({ type: 'go', screen: 'match' })} disabled={!count((clip) => clip.conflict)}>
            {count((clip) => clip.conflict)} to decide in Match Review
          </button>
        }
      />

      <div className="takes-counts" role="group" aria-label="Show">
        {(
          [
            ['all', `All ${takes.clips.length}`],
            ['unplaced', `Not placed ${count((clip) => !clip.scene)}`],
            ['disagree', `Sources disagree ${count((clip) => clip.conflict)}`],
          ] as [Filter, string][]
        ).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {label}
          </button>
        ))}
        <span className="grow" />
        {(['log', 'report', 'sound', 'manual'] as AssignSource[]).map((source) => (
          <span key={source} className="takes-source" style={tone(SOURCE[source].color)}>
            {SOURCE[source].word} {count((clip) => clip.by === source)}
          </span>
        ))}
      </div>

      {notice ? (
        <div className="intake-warning" role="alert" style={tone(statusVar('problem'))}>
          <StatusText status="problem" word="Not done" />
          <span className="muted">{notice}</span>
        </div>
      ) : null}

      <div className="takes-layout">
        <section className="card takes-clips" aria-label="Clips">
          <div className="takes-bulk" role="group" aria-label="Assign the ticked clips">
            <span className="strong">{chosen.length ? `${chosen.length} clip${chosen.length === 1 ? '' : 's'}` : 'Tick clips'}</span>
            <label>
              Scene <input className="input mono" value={slate.scene} onChange={(event) => setSlate({ ...slate, scene: event.target.value.toUpperCase() })} aria-label="Scene" />
            </label>
            <label>
              Setup <input className="input mono" value={slate.setup} onChange={(event) => setSlate({ ...slate, setup: event.target.value.toUpperCase() })} aria-label="Setup" />
            </label>
            <label>
              Take <input className="input mono" value={slate.take} onChange={(event) => setSlate({ ...slate, take: event.target.value.replace(/\D/g, '') })} aria-label="Take" />
            </label>
            <label className="row" style={{ gap: 6 }}>
              <Check checked={slate.circle} onChange={() => setSlate({ ...slate, circle: !slate.circle })} label="Circle" />◎
            </label>
            <label className="row" style={{ gap: 6 }} title="Number the ticked clips take by take, from this take">
              <Check checked={step} onChange={() => setStep(!step)} label="One take each" />
              One take each
            </label>
            <span className="grow" />
            <button type="button" className="btn ghost small" disabled={!chosen.length} onClick={backToSources} title="Forget your assignment: the sources decide again">
              Back to sources
            </button>
            <button type="button" className="btn primary small" disabled={!chosen.length} onClick={() => void assign()}>
              Assign {chosen.length || ''}
            </button>
          </div>

          {takes.clips.length === 0 ? <p className="muted">No camera clips today yet. They appear here as cards are copied.</p> : null}
          {cards.map((card) => {
            const rows = shown.filter((clip) => clip.card === card);
            if (!rows.length) return null;
            const all = rows.every((clip) => picked.includes(id(clip)));
            return (
              <table key={card} className="takes-table">
                <thead>
                  <tr>
                    <th>
                      <Check
                        checked={all}
                        onChange={() => setPicked(all ? picked.filter((other) => !rows.some((clip) => id(clip) === other)) : [...new Set([...picked, ...rows.map(id)])])}
                        label={`All clips on ${card}`}
                      />
                    </th>
                    <th className="mono">{card}</th>
                    <th>Goes to</th>
                    <th>Placed by</th>
                    <th>What each source says</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((clip) => (
                    <tr key={id(clip)} className={clip.conflict ? 'is-conflict' : !clip.scene ? 'is-unplaced' : ''}>
                      <td>
                        <Check checked={picked.includes(id(clip))} onChange={() => toggle(clip)} label={`Pick ${clip.clip}`} />
                      </td>
                      <td className="mono strong">{clip.clip}</td>
                      <td className="mono">
                        {slateText(clip)}
                        {clip.circle ? ' ◎' : ''}
                      </td>
                      <td>
                        {clip.conflict ? (
                          <button type="button" className="btn small" onClick={() => dispatch({ type: 'go', screen: 'match' })} style={tone(statusVar('needs'))}>
                            Disagree · decide
                          </button>
                        ) : clip.by ? (
                          <span className="takes-source" style={tone(SOURCE[clip.by].color)}>
                            {SOURCE[clip.by].word}
                          </span>
                        ) : (
                          <span className="faint">Not placed</span>
                        )}
                      </td>
                      <td className="small muted">
                        {clip.claims.length
                          ? clip.claims.map((claim) => (
                              <span key={claim.from} className="takes-claim" title={claim.from}>
                                {SOURCE[claim.source].word}: <span className="mono">{slateText(claim)}</span>
                              </span>
                            ))
                          : 'Nothing names it yet'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })}
        </section>

        <CameraReport cards={cards} report={takes.report} problems={takes.reportProblems} onAnswer={answer} />
      </div>
    </div>
  );
}

/** The camera report: card by card, typed in (with runs of clips filled take by take), or imported. */
function CameraReport({ cards, report, problems, onAnswer }: { cards: string[]; report: CameraReportRow[]; problems: string[]; onAnswer: (call: Promise<ProjectResult>) => void }) {
  const { state } = useStore();
  const api = state.project ? projectApi() : null;
  const reported = [...new Set(report.map((row) => row.card))];
  const all = [...new Set([...cards, ...reported])];
  const [card, setCard] = useState(all[0] ?? '');
  const saved = useMemo(() => report.filter((row) => row.card === card).map(({ id: _id, source: _source, ...row }) => row), [report, card]);
  const [rows, setRows] = useState<CameraReportInput[] | null>(null);
  const editing = rows ?? saved;
  const dirty = rows !== null;
  const [run, setRun] = useState({ from: '', to: '', scene: '', setup: '', take: '1', lens: '' });

  const update = (index: number, patch: Partial<CameraReportInput>) => setRows(editing.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const next = (text: string, by = 1) => text.replace(/(\d+)(?!.*\d)/, (digits) => String(Number(digits) + by).padStart(digits.length, '0'));
  const addRow = () => {
    const last = editing[editing.length - 1];
    setRows([...editing, last ? { ...last, clip: next(last.clip), take: next(last.take), circle: false, notes: '' } : { card, clip: 'C001', scene: '', setup: '', take: '1', circle: false, lens: '', notes: '' }]);
  };
  // A run of clips, one take each: C001–C005 as takes 1–5.
  const addRun = () => {
    const a = /(\d+)\s*$/.exec(run.from);
    const b = /(\d+)\s*$/.exec(run.to || run.from);
    if (!a || !b || !run.scene || Number(b[1]) < Number(a[1])) return;
    const prefix = run.from.slice(0, a.index);
    const added = Array.from({ length: Number(b[1]) - Number(a[1]) + 1 }, (_, i) => ({
      card,
      clip: `${prefix}${String(Number(a[1]) + i).padStart(a[1]!.length, '0')}`,
      scene: run.scene,
      setup: run.setup,
      take: String((Number(run.take) || 1) + i),
      circle: false,
      lens: run.lens,
      notes: '',
    }));
    setRows([...editing, ...added]);
    setRun({ ...run, from: next(run.to || run.from), to: '', take: String((Number(run.take) || 1) + added.length) });
  };
  const save = () => {
    if (api) onAnswer(api.setCameraReport(card, editing.map((row) => ({ ...row, card }))));
    setRows(null);
  };

  return (
    <section className="card takes-report" aria-label="Camera report">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 className="takes-h">Camera report</h2>
        <span className="row" style={{ gap: 6 }}>
          <button type="button" className="btn ghost small" disabled={!api} onClick={() => api && onAnswer(api.saveReportTemplate())}>
            Template
          </button>
          <button type="button" className="btn small" disabled={!api} onClick={() => api && onAnswer(api.importCameraReport())}>
            Import…
          </button>
        </span>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <label className="row" style={{ gap: 6 }}>
          Card
          <input
            className="input mono"
            list="report-cards"
            value={card}
            aria-label="Card or roll"
            onChange={(event) => {
              setCard(event.target.value.toUpperCase());
              setRows(null);
            }}
          />
          <datalist id="report-cards">
            {all.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <span className="muted small">{saved.length} line{saved.length === 1 ? '' : 's'} saved</span>
      </div>

      <table className="takes-table takes-report-table">
        <thead>
          <tr>
            <th>Clip</th>
            <th>Sc</th>
            <th>Setup</th>
            <th>Take</th>
            <th>◎</th>
            <th>Lens</th>
            <th>Notes</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {editing.map((row, index) => (
            <tr key={index}>
              <td>
                <input className="input mono" value={row.clip} aria-label={`Clip, line ${index + 1}`} onChange={(event) => update(index, { clip: event.target.value.toUpperCase() })} />
              </td>
              <td>
                <input className="input mono" value={row.scene} aria-label={`Scene, line ${index + 1}`} onChange={(event) => update(index, { scene: event.target.value.toUpperCase() })} />
              </td>
              <td>
                <input className="input mono" value={row.setup} aria-label={`Setup, line ${index + 1}`} onChange={(event) => update(index, { setup: event.target.value.toUpperCase() })} />
              </td>
              <td>
                <input className="input mono" value={row.take} aria-label={`Take, line ${index + 1}`} onChange={(event) => update(index, { take: event.target.value.replace(/\D/g, '') })} />
              </td>
              <td>
                <Check checked={row.circle} onChange={() => update(index, { circle: !row.circle })} label={`Circle, line ${index + 1}`} />
              </td>
              <td>
                <input className="input" value={row.lens} aria-label={`Lens, line ${index + 1}`} onChange={(event) => update(index, { lens: event.target.value })} />
              </td>
              <td>
                <input className="input" value={row.notes} aria-label={`Notes, line ${index + 1}`} onChange={(event) => update(index, { notes: event.target.value })} />
              </td>
              <td>
                <button type="button" className="btn ghost small" aria-label={`Remove line ${index + 1}`} onClick={() => setRows(editing.filter((_, i) => i !== index))}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="btn small" disabled={!card} onClick={addRow}>
          + Line
        </button>
        <span className="muted small">or a run:</span>
        <input className="input mono takes-run" placeholder="C001" aria-label="Run from clip" value={run.from} onChange={(event) => setRun({ ...run, from: event.target.value.toUpperCase() })} />
        –
        <input className="input mono takes-run" placeholder="C005" aria-label="Run to clip" value={run.to} onChange={(event) => setRun({ ...run, to: event.target.value.toUpperCase() })} />
        <input className="input mono takes-run" placeholder="Sc" aria-label="Run scene" value={run.scene} onChange={(event) => setRun({ ...run, scene: event.target.value.toUpperCase() })} />
        <input className="input mono takes-run" placeholder="Setup" aria-label="Run setup" value={run.setup} onChange={(event) => setRun({ ...run, setup: event.target.value.toUpperCase() })} />
        <input className="input mono takes-run" placeholder="T1" aria-label="Run first take" value={run.take} onChange={(event) => setRun({ ...run, take: event.target.value.replace(/\D/g, '') })} />
        <button type="button" className="btn small" disabled={!card || !run.from || !run.scene} onClick={addRun}>
          + Run
        </button>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
        {dirty ? (
          <button type="button" className="btn ghost small" onClick={() => setRows(null)}>
            Undo changes
          </button>
        ) : null}
        <button type="button" className="btn primary small" disabled={!dirty || !card || !api} onClick={save}>
          Save {card || 'report'}
        </button>
      </div>

      {problems.length ? (
        <div className="takes-problems" role="note">
          <StatusText status="needs" word="Report against the cards" />
          {problems.map((problem) => (
            <p key={problem} className="small">
              {problem}
            </p>
          ))}
        </div>
      ) : report.length ? (
        <StatusText status="done" word="Every report line is on its card, and every clip is in the report" />
      ) : null}
    </section>
  );
}
