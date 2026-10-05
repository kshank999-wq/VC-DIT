import { useEffect, useState } from 'react';
import { overall, timecodeNow } from '../model/status';
import { useStore, type ThemeChoice } from '../state/store';
import { Pill, useAccess } from '../ui/kit';

/** The 52px bar: production and day, Today / Project setup, the one status that matters, and the tools. */
export function Header({ onLicense }: { onLicense: () => void }) {
  const { state, dispatch } = useStore();
  const access = useAccess();
  const summary = overall(state);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000 / 24);
    return () => clearInterval(timer);
  }, []);
  const date = new Date(`${state.day.date}T12:00:00`);
  const dayLabel = date.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).replace(',', '');

  return (
    <header className="app-header">
      <div className="wordmark">
        <span>VC DIT</span>
        <span className="mono version">V{__APP_VERSION__.split('.').slice(0, 2).join('.')}</span>
      </div>

      <div className="production" title="Production and shoot day">
        <span className="prod-name">{state.production.name}</span>
        <span className="mono faint">{state.production.code}</span>
        <span className="divider" />
        <span className="mono">DAY {String(state.day.number).padStart(3, '0')}</span>
        <span className="mono muted">{dayLabel}</span>
      </div>

      <div className="seg" role="tablist" aria-label="Home">
        <button type="button" role="tab" aria-pressed={state.screen === 'today'} aria-selected={state.screen === 'today'} onClick={() => dispatch({ type: 'go', screen: 'today' })}>
          Today
        </button>
        <button type="button" role="tab" aria-pressed={state.screen === 'setup'} aria-selected={state.screen === 'setup'} onClick={() => dispatch({ type: 'go', screen: 'setup' })}>
          Project setup
        </button>
      </div>

      <div className="header-center">
        <button type="button" className="pill-button" onClick={() => dispatch({ type: 'go', screen: summary.screen })} title="Go to what needs you most">
          <Pill status={summary.status}>{summary.label}</Pill>
        </button>
        {access.plan === 'none' ? (
          <button type="button" className="pill-button" onClick={onLicense} title="Activate this computer">
            <Pill status="needs">{access.state === 'expired-offline' ? 'Offline too long · reconnect' : 'Not activated'}</Pill>
          </button>
        ) : null}
      </div>

      <select
        className="select theme-select"
        aria-label="Theme"
        value={state.theme}
        onChange={(event) => dispatch({ type: 'setTheme', theme: event.target.value as ThemeChoice })}
      >
        <option value="system">Auto theme</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <button type="button" className={`btn${state.screen === 'reports' ? ' primary' : ''}`} onClick={() => dispatch({ type: 'go', screen: 'reports' })}>
        Reports
      </button>
      <button type="button" className={`btn${state.filesOpen ? ' primary' : ''}`} aria-pressed={state.filesOpen} onClick={() => dispatch({ type: 'toggleFiles' })}>
        Files
      </button>
      <span className="mono clock" aria-label="Time of day">
        {timecodeNow(now)}
      </span>
      <button type="button" className="avatar" title={`${state.day.operator.name} · license`} onClick={onLicense}>
        {state.day.operator.initials}
      </button>
    </header>
  );
}
