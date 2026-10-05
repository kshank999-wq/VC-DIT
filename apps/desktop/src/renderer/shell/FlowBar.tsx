import { STATUS_WORD, STEPS, stepOfScreen, summarize } from '../model/status';
import type { ScreenId } from '../model/types';
import { useStore } from '../state/store';
import { stepTone, stepVar, statusVar, tone } from '../ui/kit';

/** The six steps, left to right, each with its one-line metric and a status dot. Click to go there. */
export function FlowBar() {
  const { state, dispatch } = useStore();
  const steps = summarize(state);
  const active = stepOfScreen(state.screen);
  return (
    <nav className="flow-bar" aria-label="Pipeline">
      {STEPS.map((step, index) => {
        const summary = steps[step.id];
        const isActive = active === step.id;
        return (
          <div key={step.id} className="flow-cell">
            {index > 0 ? (
              <span className="flow-arrow" aria-hidden="true">
                →
              </span>
            ) : null}
            <button
              type="button"
              className={`flow-step${isActive ? ' active' : ''}`}
              style={tone(stepVar(step.id))}
              aria-current={isActive ? 'step' : undefined}
              title={`${step.name} · ${STATUS_WORD[summary.status]} · Ctrl/⌘ ${step.number}`}
              onClick={() => dispatch({ type: 'go', screen: step.screen })}
            >
              <span className="flow-number" style={stepTone(step.id)}>
                {step.number}
              </span>
              <span className="flow-text">
                <span className="flow-name">{step.name}</span>
                <span className="flow-metric mono">{summary.metric}</span>
              </span>
              <span className="dot flow-dot" style={tone(statusVar(summary.status))} aria-label={STATUS_WORD[summary.status]} />
            </button>
          </div>
        );
      })}
    </nav>
  );
}

const SUB_TABS: Partial<Record<ScreenId, { screen: ScreenId; label: string }[]>> = {
  scenes: [
    { screen: 'scenes', label: 'Scene Organizer' },
    { screen: 'match', label: 'Match Review' },
  ],
  looks: [
    { screen: 'looks', label: 'Looks' },
    { screen: 'dailies', label: 'Dailies' },
    { screen: 'delivery', label: 'Delivery' },
  ],
};
SUB_TABS.match = SUB_TABS.scenes;
SUB_TABS.dailies = SUB_TABS.looks;
SUB_TABS.delivery = SUB_TABS.looks;

/** The pill row under the flow bar, for steps with more than one screen. */
export function SubTabs() {
  const { state, dispatch } = useStore();
  const tabs = SUB_TABS[state.screen];
  const step = stepOfScreen(state.screen);
  if (!tabs || !step) return null;
  const open = state.matches.filter((match) => match.resolution === null).length;
  return (
    <div className="sub-tabs" role="tablist" style={stepTone(step)}>
      {tabs.map((tab) => (
        <button
          key={tab.screen}
          type="button"
          role="tab"
          aria-selected={tab.screen === state.screen}
          className={tab.screen === state.screen ? 'active' : ''}
          onClick={() => dispatch({ type: 'go', screen: tab.screen })}
        >
          {tab.label}
          {tab.screen === 'match' && open > 0 ? <span className="badge-count">{open}</span> : null}
        </button>
      ))}
    </div>
  );
}
