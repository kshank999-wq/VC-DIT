import { useState } from 'react';
import { DAILIES_AUDIO, DAILIES_CODECS, DAILIES_GROUPING, DAILIES_LOOKS, DAILIES_RESOLUTIONS, type ProjectResult } from '../../shared/project';
import type { DailiesOptions, Scene } from '../model/types';
import { dailiesSettings, projectApi } from '../state/engine';
import { DESTINATION_ROLES, useStore } from '../state/store';
import { Chip, ScreenHeader, StartButton, StatusText, statusVar, tone } from '../ui/kit';
import './output.css';

/**
 * Dailies: review copies grouped by scene, setup and take, synced, with the
 * viewing look and slate metadata (spec §4.8). Circle takes from the script
 * log are tagged as selects. Originals are never touched; the look applied is
 * recorded in metadata and in the report (spec §4.7). In the desktop app
 * they are rendered with FFmpeg (src/main/dailies) into SYNCED_DAILIES on the
 * chosen destination, with a manifest in REPORTS/dailies.
 */

const INCLUDE: { value: DailiesOptions['include']; title: string }[] = [
  { value: 'circle', title: 'Circle takes only' },
  { value: 'all', title: 'All takes' },
  { value: 'scene', title: 'By scene…' },
];

/** About 1.7 GB a minute for ProRes 422 Proxy at 1080; a planning figure, not a promise. */
const GB_PER_MINUTE = 1.7;

/** Takes, minutes and size for an include choice, counted from the day's takes. */
export const dailiesFigures = (scenes: Scene[], include: DailiesOptions['include'], chosen?: string[]) => {
  const takes = scenes
    .filter((scene) => include !== 'scene' || !chosen || chosen.includes(scene.id))
    .flatMap((scene) => scene.setups.flatMap((setup) => setup.takes))
    .filter((take) => include === 'all' || (include === 'scene' && chosen) || take.circle);
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
  const api = state.project ? projectApi() : null;
  const [notice, setNotice] = useState<string | null>(null);
  const act = (call: Promise<ProjectResult>) =>
    void call.then((result) => {
      if (result.ok) {
        setNotice(null);
        dispatch({ type: 'projectState', project: result.state });
      } else if (result.reason) setNotice(result.reason);
    });
  // Where dailies can go: the destination drives and folders the media engine knows.
  const destinations = [
    ...state.volumes.filter((volume) => DESTINATION_ROLES.includes(volume.role)).map((volume) => ({ id: volume.id, name: volume.name })),
    ...state.destinations.map((destination) => ({ id: destination.id, name: destination.name })),
  ];
  const fields = api
    ? [
        { key: 'codec' as const, label: 'Codec', options: DAILIES_CODECS },
        { key: 'resolution' as const, label: 'Resolution', options: DAILIES_RESOLUTIONS },
        { key: 'audio' as const, label: 'Audio', options: DAILIES_AUDIO },
        { key: 'look' as const, label: 'Look', options: DAILIES_LOOKS },
        { key: 'grouping' as const, label: 'Grouping', options: DAILIES_GROUPING },
      ]
    : FIELDS;
  const chosenScenes = dailies.scenes ?? [];
  const tree = publishTree(state.production.name, state.day.number, state.day.date, state.scenes);
  const detail = (include: DailiesOptions['include']) => {
    if (include === 'scene' && !(api && chosenScenes.length)) return 'choose scenes';
    const figures = dailiesFigures(state.scenes, include, api ? chosenScenes : undefined);
    return `${figures.takes} takes · ${figures.minutes} min`;
  };
  // "By scene" has no scene picker yet, so it counts the circle takes like the default.
  const chosen = api
    ? dailiesFigures(state.scenes, dailies.include, chosenScenes)
    : dailiesFigures(state.scenes, dailies.include === 'all' ? 'all' : 'circle');
  const destinationReason = api && !destinations.some((destination) => destination.id === dailies.destination) ? 'Pick where the dailies go.' : null;
  const buildReason = !api
    ? null
    : !state.ffmpeg
      ? 'FFmpeg is not available on this computer.'
      : state.dailiesActivity
        ? 'Dailies are rendering.'
        : chosen.takes === 0
          ? 'No takes for this choice yet.'
          : destinationReason;
  const done = state.renders.filter((render) => render.state === 'done').length;

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
            {api && dailies.include === 'scene' ? (
              <div className="row wrap gap-6" role="group" aria-label="Scenes">
                {state.scenes
                  .filter((scene) => scene.setups.length > 0)
                  .map((scene) => {
                    const on = chosenScenes.includes(scene.id);
                    return (
                      <button
                        key={scene.id}
                        type="button"
                        className="burn-chip"
                        aria-pressed={on}
                        onClick={() =>
                          dispatch({ type: 'setDailies', patch: { scenes: on ? chosenScenes.filter((id) => id !== scene.id) : [...chosenScenes, scene.id] } })
                        }
                      >
                        {on ? '✓ ' : ''}Sc {scene.id}
                      </button>
                    );
                  })}
              </div>
            ) : null}
          </div>

          <div className="field-grid">
            {fields.map((field) => {
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
            {api ? (
              <label className="field">
                <span className="label">Destination</span>
                <select
                  className="select"
                  value={dailies.destination}
                  onChange={(event) => dispatch({ type: 'setDailies', patch: { destination: event.target.value } })}
                >
                  <option value="">{destinations.length ? 'Choose…' : 'No destinations: set one up on Intake'}</option>
                  {destinations.map((destination) => (
                    <option key={destination.id} value={destination.id}>
                      {destination.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
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
              <span className="mono strong summary-title">{`${chosen.takes} clip${chosen.takes === 1 ? '' : 's'} · ~${chosen.minutes} min · ≈ ${chosen.gb} GB`}</span>
              <span className="muted small">Originals untouched. Look recorded in metadata and report.</span>
            </div>
            {api ? (
              state.dailiesActivity ? (
                <div className="row">
                  <StatusText status="working" word={state.dailiesActivity} />
                  <button type="button" className="btn" onClick={() => act(api.stopDailies())}>
                    Stop
                  </button>
                </div>
              ) : (
                <StartButton big disabledReason={buildReason} onClick={() => act(api.startDailies(dailiesSettings(dailies)))}>
                  {done ? 'Build dailies again' : 'Build dailies'}
                </StartButton>
              )
            ) : dailies.built ? (
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

        {api ? (
          <section className="card">
            <div className="card-head">
              <h3>Rendered today</h3>
              <span className="muted small">{state.ffmpeg ? `FFmpeg ${state.ffmpeg.version}` : 'FFmpeg not available'}</span>
            </div>
            {notice ? (
              <p className="dailies-notice" role="alert" style={tone(statusVar('problem'))}>
                {notice}
              </p>
            ) : null}
            {state.renders.length === 0 ? (
              <p className="muted small dailies-empty">
                Nothing yet. Dailies go to SYNCED_DAILIES / scene / setup on the destination, with the looks in LUTS_LOOKS and a manifest in
                REPORTS/dailies.
              </p>
            ) : (
              <ul className="dailies-renders">
                {state.renders.map((render) => (
                  <li key={`${render.takeId}-${render.clip}`}>
                    <div className="row">
                      <span className="mono strong">{render.label}</span>
                      <span className="mono muted">{render.clip}</span>
                      <span className="grow" />
                      <Chip color={statusVar(render.state === 'done' ? (render.warnings.length ? 'needs' : 'done') : 'problem')}>{render.state === 'done' ? 'Rendered' : 'Failed'}</Chip>
                      {render.state === 'done' ? (
                        <button type="button" className="btn ghost small" onClick={() => void api.showDaily(render.output)}>
                          Show
                        </button>
                      ) : null}
                    </div>
                    <span className="muted small">
                      {render.error ??
                        [render.codec, render.lut ?? 'no look', render.bytes ? `${(render.bytes / 1e6).toFixed(1)} MB` : null, ...render.warnings].filter(Boolean).join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small fio-note">Publishing to Frame.io comes with the Frame.io connection.</p>
          </section>
        ) : (
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
        )}
      </div>
    </div>
  );
}
