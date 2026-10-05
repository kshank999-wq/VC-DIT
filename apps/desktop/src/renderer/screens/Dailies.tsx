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

const INCLUDE: { value: DailiesOptions['include']; title: string; detail: string }[] = [
  { value: 'circle', title: 'Circle takes only', detail: '14 takes · 18 min' },
  { value: 'all', title: 'All takes', detail: '36 takes · 52 min' },
  { value: 'scene', title: 'By scene…', detail: 'choose scenes' },
];

type Field = 'codec' | 'resolution' | 'audio' | 'look' | 'grouping' | 'destination';

const FIELDS: { key: Field; label: string; options: string[] }[] = [
  { key: 'codec', label: 'Codec', options: ['ProRes 422 Proxy', 'ProRes 422 LT', 'DNxHD 36', 'H.264 · 10 Mb/s'] },
  { key: 'resolution', label: 'Resolution', options: ['1920 × 1080 · letterbox 2.39', '1920 × 1080 · full frame', '1280 × 720 · letterbox 2.39'] },
  { key: 'audio', label: 'Audio', options: ['Synced · mix trk + boom', 'Synced · mix trk only', 'Camera scratch only'] },
  { key: 'look', label: 'Look', options: ['Per assignment rules', 'Project default only', 'None · LOG original'] },
  { key: 'grouping', label: 'Grouping', options: ['Scene → Setup → Take', 'Camera roll', 'Shoot order'] },
  { key: 'destination', label: 'Destination', options: ['Frame.io + PROD_NAS', 'Frame.io only', 'PROD_NAS only'] },
];

const SUMMARY: Record<DailiesOptions['include'], string> = {
  circle: '14 clips · ~18 min · ≈ 31 GB',
  all: '36 clips · ~52 min · ≈ 86 GB',
  scene: '14 clips · ~18 min · ≈ 31 GB',
};

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
                  <span className="mono muted small">{option.detail}</span>
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
              <span className="mono strong summary-title">{SUMMARY[dailies.include]}</span>
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
