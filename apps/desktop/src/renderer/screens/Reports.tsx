import { useEffect, useState } from 'react';
import type { ReportEntry } from '../../shared/project';
import { jobState, STEPS } from '../model/status';
import { REPORTS } from '../model/demo';
import type { ReportRow, Status } from '../model/types';
import { projectApi } from '../state/engine';
import { useStore, type AppState, type ReportFilter } from '../state/store';
import { ScreenHeader, StatusText, statusVar, stepVar, tone } from '../ui/kit';
import './ingest.css';

/**
 * Reports: every report the day has written (ASC MHL, script import, sync,
 * VFX, looks, delivery), filterable by step, each one a jump to the screen
 * it came from. Rows whose subject is still live (a card's transfer, the
 * script-log matches, sync) take their status from state, so Reports never
 * says something Verify, Match review or Sync disagrees with (spec §8).
 */

const FILTERS: { value: ReportFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'verify', label: 'Verify' },
  { value: 'organize', label: 'Organize' },
  { value: 'vfx', label: 'VFX' },
  { value: 'sync', label: 'Sync' },
  { value: 'output', label: 'Output' },
];

const STATUS: Record<ReportRow['status'], Status> = { Complete: 'done', 'Needs you': 'needs', Problem: 'problem' };

interface LiveRow extends ReportRow {
  tone: Status;
  word: string;
}

/** The demo's report list, with live status where the subject is still changing. */
const live = (state: AppState): LiveRow[] =>
  REPORTS.map((row) => {
    const base: LiveRow = { ...row, tone: STATUS[row.status], word: row.status };
    const card = /^Ingest verification — (.+)$/.exec(row.name)?.[1];
    const job = card ? state.jobs.find((candidate) => candidate.id === card) : undefined;
    if (job) {
      const now = jobState(job);
      const covers = `ASC MHL · ${job.files} · ${job.legs.length} destinations`;
      if (now === 'safe') return { ...base, status: 'Complete', tone: 'done', word: 'Complete', covers: row.status === 'Complete' ? row.covers : covers };
      if (now === 'running' || now === 'waiting') {
        const redo = job.legs.filter((leg) => leg.copyPct < 100 || leg.verifyPct < 100).map((leg) => leg.name);
        return { ...base, tone: 'working', word: 'In progress', covers: `Copying and checking · ${redo.join(', ')}` };
      }
      return base;
    }
    if (row.screen === 'match') {
      const open = state.matches.filter((match) => match.resolution === null).length;
      return open === 0 ? { ...base, status: 'Complete', tone: 'done', word: 'Complete' } : base;
    }
    if (row.step === 'sync') {
      const open = state.sync.filter((item) => !item.accepted).length;
      return open === 0 ? { ...base, status: 'Complete', tone: 'done', word: 'Complete' } : base;
    }
    return base;
  });

export function Reports() {
  const { state } = useStore();
  return state.project ? <ProjectReports /> : <DemoReports />;
}

function DemoReports() {
  const { state, dispatch } = useStore();
  const rows = live(state).filter((row) => state.reportFilter === 'all' || row.step === state.reportFilter);

  return (
    <div className="screen">
      <ScreenHeader
        eyebrow={`Reports · Day ${String(state.day.number).padStart(3, '0')}`}
        title="Reports & logs"
        description="Every copy, match, sync and delivery is recorded. Export any report for production or post."
        actions={
          <button type="button" className="btn primary" title="Writes every report and the day's ASC MHL files to 08_REPORTS">
            Export day package (PDF + MHL)
          </button>
        }
      />

      <div className="row wrap reports-filters" role="group" aria-label="Filter by step">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            className="reports-filter"
            aria-pressed={state.reportFilter === filter.value}
            style={tone(filter.value === 'all' ? 'var(--text)' : stepVar(filter.value))}
            onClick={() => dispatch({ type: 'setReportFilter', filter: filter.value })}
          >
            <span className="reports-swatch" />
            {filter.label}
          </button>
        ))}
      </div>

      <div className="card reports-table">
        <table className="grid">
          <thead>
            <tr>
              <th className="label">Step</th>
              <th className="label">Report</th>
              <th className="label">Covers</th>
              <th className="label">Time</th>
              <th className="label">Status</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const step = STEPS.find((candidate) => candidate.id === row.step)!;
              return (
                <tr key={row.name}>
                  <td>
                    <span className="mono reports-step" style={tone(stepVar(row.step))}>
                      <span className="reports-swatch" />
                      {step.id === 'sync' ? 'Sync' : step.name}
                    </span>
                  </td>
                  <td className="reports-name">{row.name}</td>
                  <td className="muted">{row.covers}</td>
                  <td className="mono muted">{row.time}</td>
                  <td>
                    <StatusText status={row.tone} word={row.word} />
                  </td>
                  <td>
                    <div className="row reports-actions">
                      <button type="button" className="btn small" aria-label={`Open ${row.name}`} onClick={() => dispatch({ type: 'go', screen: row.screen })}>
                        Open
                      </button>
                      <button type="button" className="btn small" aria-label={`Export ${row.name}`} title="Writes PDF + CSV to 08_REPORTS">
                        Export
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No reports for this step yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------ the desktop app: the production's own reports

const time = (iso: string | null) => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
};

/** A card still copying shows as it is now, from the media engine, not as the database last saw it. */
const withLive = (state: AppState, entry: ReportEntry): ReportEntry => {
  const job = entry.card ? state.jobs.find((candidate) => candidate.id === entry.card || candidate.label === entry.card) : undefined;
  if (!job) return entry;
  const now = jobState(job);
  if (now === 'running' || now === 'waiting') return { ...entry, status: 'working', word: 'In progress' };
  if (now === 'problem' && entry.status !== 'problem') return { ...entry, status: 'problem', word: 'Problem' };
  return entry;
};

function ProjectReports() {
  const { state, dispatch } = useStore();
  const api = projectApi()!;
  const [entries, setEntries] = useState<ReportEntry[] | null>(null);
  const [notice, setNotice] = useState<{ text: string; path?: string; problem?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  // Read again when anything the reports cover changes; a burst of changes reads once.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void api.reports().then((list) => live && setEntries(list));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, state.project?.file, state.day.number, state.jobs, state.matches, state.sync, state.vfx, state.renders, state.luts, state.delivery?.records, state.organize]);

  const exportReport = (where: 'save' | 'drives') => {
    setBusy(true);
    void api.dayReport(where).then((result) => {
      setBusy(false);
      if (result.ok)
        setNotice({
          text: where === 'drives' ? `Day report written to ${result.written.length} drive${result.written.length === 1 ? '' : 's'} (REPORTS/day_report).` : 'Day report saved.',
          path: result.written[0],
        });
      else if (result.reason) setNotice({ text: result.reason, problem: true });
    });
  };

  const rows = (entries ?? []).map((entry) => withLive(state, entry)).filter((row) => state.reportFilter === 'all' || row.step === state.reportFilter);

  return (
    <div className="screen">
      <ScreenHeader
        eyebrow={`Reports · Day ${String(state.day.number).padStart(3, '0')}`}
        title="Reports & logs"
        description="Every copy, match, sync and delivery is recorded. The day report puts it all on a few pages for production and post."
        actions={
          <div className="row gap-8">
            <button type="button" className="btn" disabled={busy} title="Writes the day report PDF into REPORTS/day_report on every drive holding this day" onClick={() => exportReport('drives')}>
              Write to drives
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => exportReport('save')}>
              {busy ? 'Writing…' : 'Save day report (PDF)…'}
            </button>
          </div>
        }
      />
      {notice ? (
        <p className="row gap-8 small" role={notice.problem ? 'alert' : 'status'} style={{ color: notice.problem ? statusVar('problem') : statusVar('done') }}>
          <span>{notice.text}</span>
          {notice.path ? (
            <button type="button" className="link small" onClick={() => void api.showReport(notice.path!)}>
              Show
            </button>
          ) : null}
        </p>
      ) : null}

      <div className="row wrap reports-filters" role="group" aria-label="Filter by step">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            className="reports-filter"
            aria-pressed={state.reportFilter === filter.value}
            style={tone(filter.value === 'all' ? 'var(--text)' : stepVar(filter.value))}
            onClick={() => dispatch({ type: 'setReportFilter', filter: filter.value })}
          >
            <span className="reports-swatch" />
            {filter.label}
          </button>
        ))}
      </div>

      <div className="card reports-table">
        <table className="grid">
          <thead>
            <tr>
              <th className="label">Step</th>
              <th className="label">Report</th>
              <th className="label">Covers</th>
              <th className="label">Time</th>
              <th className="label">Status</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const step = STEPS.find((candidate) => candidate.id === row.step)!;
              return (
                <tr key={row.id}>
                  <td>
                    <span className="mono reports-step" style={tone(stepVar(row.step))}>
                      <span className="reports-swatch" />
                      {step.id === 'sync' ? 'Sync' : step.name}
                    </span>
                  </td>
                  <td className="reports-name">{row.name}</td>
                  <td className="muted">{row.covers}</td>
                  <td className="mono muted">{time(row.time)}</td>
                  <td>
                    <StatusText status={row.status} word={row.word} />
                  </td>
                  <td>
                    <div className="row reports-actions">
                      <button type="button" className="btn small" aria-label={`Open ${row.name}`} onClick={() => dispatch({ type: 'go', screen: row.screen })}>
                        Open
                      </button>
                      {row.files[0] ? (
                        <button type="button" className="btn small" aria-label={`Show the files of ${row.name}`} title={row.files[0]} onClick={() => void api.showReport(row.files[0]!)}>
                          Show file
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  {entries === null ? 'Reading the reports…' : state.reportFilter === 'all' ? 'Nothing recorded for this day yet.' : 'No reports for this step yet.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
