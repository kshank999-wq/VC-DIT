import { overall, STEPS, summarize, todos } from '../model/status';
import { useStore } from '../state/store';
import { StatusText, stepVar, statusVar, tone } from '../ui/kit';
import './today.css';

/**
 * Today: one sentence about how the day stands, the six steps as tiles, and
 * what to do next, most urgent first. Everything here is derived from state
 * (model/status.ts), so it changes the moment anything does.
 */
export function Today() {
  const { state, dispatch } = useStore();
  const steps = summarize(state);
  const summary = overall(state, steps);
  const list = todos(state);
  const date = new Date(`${state.day.date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).replace(',', '');

  return (
    <div className="screen today">
      <div>
        <div className="muted">
          Day {String(state.day.number).padStart(3, '0')} · {state.day.locations} · {date}
        </div>
        <h1 className="today-headline" style={{ color: statusVar(summary.status === 'done' ? 'done' : summary.status) }}>
          {summary.headline}
        </h1>
      </div>

      <div className="tiles">
        {STEPS.map((step) => {
          const item = steps[step.id];
          return (
            <button key={step.id} type="button" className="tile card" style={tone(stepVar(step.id))} onClick={() => dispatch({ type: 'go', screen: step.screen })}>
              <span className="eyebrow plain">
                {step.number} · {step.name}
              </span>
              <span className="tile-metric">{item.metric}</span>
              <span className="muted">{item.detail}</span>
              <span className="row tile-foot">
                <StatusText status={item.status} word={item.word} />
                <span className="grow" />
                <span className="muted">Open →</span>
              </span>
            </button>
          );
        })}
      </div>

      <section className="stack">
        <h2 className="section-title">Do these next</h2>
        {list.length === 0 ? <p className="muted">Nothing waiting on you.</p> : null}
        {list.map((todo) => {
          const step = STEPS.find((candidate) => candidate.id === todo.step)!;
          return (
            <div key={todo.id} className="todo card">
              <span className="dot" style={tone(statusVar(todo.status))} aria-label={todo.status} />
              <div className="grow">
                <div className="todo-title">{todo.title}</div>
                <div className="muted">{todo.detail}</div>
              </div>
              <span className="label" style={{ color: stepVar(todo.step) }}>
                {String(step.number).padStart(2, '0')} · {step.name}
              </span>
              <button
                type="button"
                className={`btn primary${todo.status === 'problem' ? ' danger' : ''}`}
                onClick={() => {
                  if (todo.retry) dispatch({ type: 'retryLeg', ...todo.retry });
                  dispatch({ type: 'go', screen: todo.screen });
                }}
              >
                {todo.action}
              </button>
            </div>
          );
        })}
      </section>
    </div>
  );
}
