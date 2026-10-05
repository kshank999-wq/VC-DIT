import type { DailiesOptions, Scene } from '../model/types';
import { useStore } from '../state/store';
import { ScreenHeader, StartButton, StatusText } from '../ui/kit';
import './output.css';

/**
 * Dailies: review copies grouped by scene, setup and take, synced, with the
 * viewing look and slate metadata (spec §4.8). Circle takes from the script
 * log are tagged as selects. Originals are never touched; the look applied is
 * recorded in metadata and in the report (spec §4.7).
 */

const INCLUDE: { value: DailiesOptions['include']; title: string }[] = [
  { value: 'circle', title: 'Circle takes only' },
  { value: 'all', title: 'All takes' },
  { value: 'scene', title: 'By scene…' },
];

/** About 1.7 GB a minute for ProRes 422 Proxy at 1080; a planning figure, not a promise. */
const GB_PER_MINUTE = 1.7;

/** Takes, minutes and size for an include choice, counted from the day's takes. */
export const dailiesFigures = (scenes: Scene[], include: DailiesOptions['include']) => {
  const takes = scenes.flatMap((scene) => scene.setups.flatMap((setup) => setup.takes)).filter((take) => include === 'all' || take.circle);
  const seconds = takes.reduce((sum, take) => {
    const [minutes = 0, secs = 0] = take.duration.split(':').map(Number);
    return sum + minutes * 60 + secs;
  }, 0);
  const minutes = Math.round(seconds / 60);
  return { takes: takes.length, minutes, gb: Math.round(minutes * GB_PER_MINUTE) };
};

type Field = 'codec' | 'resolution' | 'audio' | 'look' | 'grouping' | 'destination';

const FIELDS: { key: Field; label: string; options: string[] }[] = [
  { key: 'codec', label: 'Codec', options: ['ProRes 422 Proxy', 'ProRes 422 LT', 'DNxHD 36', 'H.264 · 10 Mb/s'] },
  { key: 'resolution', label: 'Resolution', options: ['1920 × 1080 · letterbox 2.39', '1920 × 1080 · full frame', '1280 × 720 · letterbox 2.39'] },
  { key: 'audio', label: 'Audio', options: ['Synced · mix trk + boom', 'Synced · mix trk only', 'Camera scratch only'] },
  { key: 'look', label: 'Look', options: ['Per assignment rules', 'Project default only', 'None · LOG original'] },
  { key: 'grouping', label: 'Grouping', options: ['Scene → Setup → Take', 'Camera roll', 'Shoot order'] },
  { key: 'destination', label: 'Destination', options: ['Frame.io + PROD_NAS', 'Frame.io only', 'PROD_NAS only'] },
];


const sceneFolder = (id: string) => `Sc ${id.replace(/^\d+/, (digits) => digits.padStart(3, '0'))}/`;
const clipName = (scene: string, setup: string, take: string) => `${scene}${/[A-Z]$/.test(scene) ? '-' : ''}${setup}_${take} ◎.mov`;

/** The Frame.io folder tree, from the scenes that have circle takes; two per scene, then "…". */
export const publishTree = (production: string, day: number, date: string, scenes: Scene[]): string => {
  const withCircles = scenes
    .map((scene) => ({
      folder: sceneFolder(scene.id),
      clips: scene.setups.flatMap((setup) => setup.takes.filter((take) => take.circle).map((take) => clipName(scene.id, setup.id, take.take))),
    }))
    .filter((scene) => scene.clips.length > 0);
  const lines = [`${production}/`, '└ Dailies/', `  └ Day ${String(day).padStart(3, '0')} — ${date}/`];
  withCircles.forEach((scene, sceneIndex) => {
    const lastScene = sceneIndex === withCircles.length - 1;
    lines.push(`    ${lastScene ? '└' : '├'} ${scene.folder}`);
    const shown = scene.clips.slice(0, 2);
    shown.forEach((clip, clipIndex) => {
      const lastClip = clipIndex === shown.length - 1;
      const more = lastClip && scene.clips.length > shown.length ? ' …' : '';
      lines.push(`    ${lastScene ? ' ' : '│'} ${lastClip ? '└' : '├'} ${clip}${more}`);
    });
  });
  return lines.join('\n');
};

export function Dailies() {
  const { state, dispatch } = useStore();
  const { dailies } = state;
  const tree = publishTree(state.production.name, state.day.number, state.day.date, state.scenes);
  const detail = (include: DailiesOptions['include']) => {
    if (include === 'scene') return 'choose scenes';
    const figures = dailiesFigures(state.scenes, include);
    return `${figures.takes} takes · ${figures.minutes} min`;
  };
  // "By scene" has no scene picker yet, so it counts the circle takes like the default.
  const chosen = dailiesFigures(state.scenes, dailies.include === 'all' ? 'all' : 'circle');

  return (
    <div className="screen out">
      <ScreenHeader
        step="output"
        eyebrow="06 · Output · Dailies"
        title={`Day ${String(state.day.number).padStart(3, '0')} dailies`}
        description="Review-ready media grouped by scene, setup and take — synced, with look and slate metadata."
      />

      <div className="dailies-layout">
        <section className="card dailies-form">
          <div className="stack gap-8">
            <span className="label" id="dailies-include">
              Include
            </span>
            <div className="include-row" role="group" aria-labelledby="dailies-include">
              {INCLUDE.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="include-card"
                  aria-pressed={dailies.include === option.value}
                  onClick={() => dispatch({ type: 'setDailies', patch: { include: option.value } })}
                >
                  <span className="strong">{option.title}</span>
                  <span className="mono muted small">{detail(option.value)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="field-grid">
            {FIELDS.map((field) => {
              const value = dailies[field.key];
              const options = field.options.includes(value) ? field.options : [value, ...field.options];
              return (
                <label key={field.key} className="field">
                  <span className="label">{field.label}</span>
                  <select className="select" value={value} onChange={(event) => dispatch({ type: 'setDailies', patch: { [field.key]: event.target.value } })}>
                    {options.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>

          <div className="stack gap-8">
            <span className="label">Burn-ins &amp; metadata</span>
            <div className="row wrap gap-6">
              {Object.entries(dailies.burnIns).map(([key, on]) => (
                <button key={key} type="button" className="burn-chip" aria-pressed={on} onClick={() => dispatch({ type: 'toggleBurnIn', key })}>
                  {on ? '✓ ' : ''}
                  {key}
                </button>
              ))}
            </div>
          </div>

          <div className="row summary-row">
            <div className="grow stack gap-3">
              <span className="mono strong summary-title">{`${chosen.takes} clips · ~${chosen.minutes} min · ≈ ${chosen.gb} GB`}</span>
              <span className="muted small">Originals untouched. Look recorded in metadata and report.</span>
            </div>
            {dailies.built ? (
              <div className="row">
                <StatusText status="done" word="Built · ready to deliver" />
                <button type="button" className="btn primary big" onClick={() => dispatch({ type: 'go', screen: 'delivery' })}>
                  Go to Delivery →
                </button>
              </div>
            ) : (
              <StartButton big onClick={() => dispatch({ type: 'buildDailies' })}>
                Build dailies
              </StartButton>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Frame.io publish target</h3>
            <span className="small">
              <StatusText status="done" word="Connected" />
            </span>
          </div>
          <pre className="mono fio-tree" aria-label="Frame.io folder structure">
            {tree}
          </pre>
          <p className="muted small fio-note">Circle takes are tagged "Select". Look name and script notes travel as comments/metadata.</p>
        </section>
      </div>
    </div>
  );
}
