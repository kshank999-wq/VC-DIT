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
      const now = jobState(job, state.production.formatRule);
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
  const now = jobState(job, state.production.formatRule);
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

  const exportReport = (what: 'report' | 'film-studio' | 'drives' | 'send') => {
    setBusy(true);
    const work =
      what === 'send'
        ? // Straight to the production in VC Film Studio. Its own warnings (a day it has no date for) follow the count.
          api.sendToFilmStudio().then((result) => (result.ok ? { ok: true as const, text: [result.text, ...result.warnings].join(' '), path: undefined } : result))
        : what === 'report'
        ? api.dayReport('save').then((result) => (result.ok ? { ok: true as const, text: 'Day report saved.', path: result.written[0] } : result))
        : what === 'film-studio'
          ? api.filmStudio('save').then((result) =>
              result.ok ? { ok: true as const, text: 'Day log saved for VC Film Studio, with the day report PDF beside it.', path: result.written[0] } : result,
            )
          : // To the drives: the day report and the VC Film Studio log together.
            api.dayReport('drives').then(async (result) => {
              if (!result.ok) return result;
              const log = await api.filmStudio('drives');
              if (!log.ok) return log;
              const count = result.written.length;
              return { ok: true as const, text: `Day report and VC Film Studio log written to ${count} drive${count === 1 ? '' : 's'} (REPORTS/day_report, REPORTS/vc_film_studio).`, path: result.written[0] };
            });
    void work.then((result) => {
      setBusy(false);
      if (result.ok) setNotice({ text: result.text, path: result.path });
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
            <button type="button" className="btn" disabled={busy} title="Writes the day report and the VC Film Studio log onto every drive holding this day" onClick={() => exportReport('drives')}>
              Write to drives
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => exportReport('report')}>
              Save day report (PDF)…
            </button>
            <button type="button" className="btn" disabled={busy} title="The day's DIT log (cards, copies, notes, takes, sync, dailies, VFX, deliveries) as a file for VC Film Studio's data desk" onClick={() => exportReport('film-studio')}>
              Export to VC Film Studio…
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              title="Sends the day's DIT log straight to this production in VC Film Studio, with the upload key from Project setup. Sending a day again adds only what is new."
              onClick={() => exportReport('send')}
            >
              {busy ? 'Working…' : 'Send to VC Film Studio'}
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
