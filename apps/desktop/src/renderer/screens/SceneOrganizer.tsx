import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { legState } from '../model/status';
import type { SceneStatus, Status, Take } from '../model/types';
import { projectApi } from '../state/engine';
import { useStore, type AppState, type PoolFilter } from '../state/store';
import { Frame, statusVar, stepVar, tone } from '../ui/kit';
import './organize.css';

/**
 * Scene Organizer: the day's takes laid out like an NLE media page. Bins on
 * the left (smart bins and Scene → Setup), a viewer and clip info on top, the
 * setup's media pool below.
 *
 * Spec §4.4: every take is always retained. Circle takes and VFX shots are
 * filtered views of the same clips, never moves or copies.
 */

const SCENE_STATUS: Record<SceneStatus, Status> = { Shot: 'done', Shooting: 'working', Scheduled: 'idle', Dropped: 'idle' };

const SMART_BINS: { filter: PoolFilter; label: string; test: (take: Take) => boolean }[] = [
  { filter: 'all', label: 'All clips', test: () => true },
  { filter: 'circle', label: 'Circle takes', test: (take) => take.circle },
  { filter: 'vfx', label: 'VFX shots', test: (take) => take.vfx },
];

const SYNC: Record<Take['sync'], [string, Status]> = {
  TC: ['Synced · timecode', 'done'],
  WF: ['Check · waveform', 'needs'],
  none: ['Missing', 'problem'],
  pending: ['Not synced yet', 'idle'],
};

const MATCH: Record<Take['match'], [string, Status]> = {
  Matched: ['Matched', 'done'],
  Review: ['Needs review', 'needs'],
  Unmatched: ['Unmatched', 'problem'],
};

/** How many of the card's copies are verified, from the transfer that brought this clip in. */
const verified = (state: AppState, clip: string): [string, Status] => {
  const job = state.jobs.find((candidate) => clip.startsWith(candidate.id));
  if (!job) return ['Not ingested yet', 'idle'];
  const legs = job.legs.map(legState);
  const done = legs.filter((leg) => leg === 'verified').length;
  const text = `${done} of ${legs.length} copies`;
  if (legs.includes('failed')) return [`${text} · 1 failed`, 'problem'];
  if (done === legs.length) return [text, 'done'];
  return [`${text} · checking`, 'working'];
};

const pad3 = (id: string) => id.padStart(3, '0');

export function SceneOrganizer() {
  const { state, dispatch } = useStore();
  const pool = useRef<HTMLDivElement>(null);
  const [sceneId, setupId] = state.selectedSetup.split('|') as [string, string];
  const scene = state.scenes.find((candidate) => candidate.id === sceneId);
  const setup = scene?.setups.find((candidate) => candidate.id === setupId);
  const takes = setup?.takes ?? [];
  const bin = SMART_BINS.find((candidate) => candidate.filter === state.poolFilter) ?? SMART_BINS[0]!;
  const shown = takes.filter(bin.test);
  const take = shown.find((candidate) => candidate.id === state.selectedTake) ?? shown[0] ?? null;
  const look = scene?.look.replace(/\.cube$/, '') ?? '';

  const move = (by: number) => {
    if (!take) return;
    const next = shown[shown.indexOf(take) + by];
    if (!next) return;
    dispatch({ type: 'selectTake', take: next.id });
    pool.current?.querySelector<HTMLButtonElement>(`[data-take="${next.id}"]`)?.focus();
  };
  const onPoolKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      move(event.key === 'ArrowRight' ? 1 : -1);
    }
  };

  const info: [string, string, Status | 'vfx' | null][] = take
    ? [
        ['Scene', sceneId, null],
        ['Setup', setupId, null],
        ['Take', String(Number(take.take.slice(1))), null],
        ['Camera A', take.clipA, null],
        ['Camera B', take.clipB ?? '—', null],
        ['Start TC', take.tc, null],
        ['Duration', take.duration, null],
        ['Sound', take.sound, null],
        ['Sync', ...SYNC[take.sync]],
        ['Look', look || '—', null],
        ['Select', take.circle ? '◎ Circle take' : 'No', take.circle ? 'needs' : null],
        ['VFX', take.vfx ? 'Yes · mirrored' : 'No', take.vfx ? 'vfx' : null],
        ['Script match', ...MATCH[take.match]],
        ['Verified', ...verified(state, take.clipA)],
      ]
    : [];

  return (
    <div className="organizer" style={tone(stepVar('organize'))}>
      <nav className="org-bins" aria-label="Bins">
        <div className="org-bin-group">
          <div className="label org-bin-title">Smart bins</div>
          {SMART_BINS.map((item) => (
            <button
              key={item.filter}
              type="button"
              className="org-bin"
              aria-pressed={state.poolFilter === item.filter}
              onClick={() => dispatch({ type: 'setPoolFilter', filter: item.filter })}
            >
              <span className="grow">{item.label}</span>
              <span className="mono muted">{takes.filter(item.test).length}</span>
            </button>
          ))}
        </div>
        <div className="org-bin-group">
          <div className="label org-bin-title">Scene bins</div>
          {state.scenes
            .filter((candidate) => candidate.setups.length > 0)
            .map((candidate) => (
              <div key={candidate.id} className="org-bin-scene">
                <div className="org-bin-scene-name" title={candidate.status}>
                  <span className="dot" style={tone(statusVar(SCENE_STATUS[candidate.status]))} aria-label={candidate.status} />
                  Scene {candidate.id}
                </div>
                {candidate.setups.map((item) => {
                  const key = `${candidate.id}|${item.id}`;
                  return (
                    <button
                      key={key}
                      type="button"
                      className="org-bin org-setup"
                      aria-pressed={state.selectedSetup === key}
                      onClick={() => dispatch({ type: 'selectSetup', key })}
                    >
                      <span className="grow">Setup {item.id}</span>
                      <span className="mono muted" aria-label={`${item.takes.length} takes`}>
                        {item.takes.length}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
        </div>
        {state.organize ? <SceneFolders /> : null}
      </nav>

      <div className="org-main">
        <div className="org-top">
          <section className="org-viewer" aria-label="Viewer">
            <div className="org-bar">
              <span className="eyebrow">03 · Organize</span>
              <strong className="nowrap">
                Scene {sceneId} / Setup {setupId}
              </strong>
              <span className="muted ellipsis">{scene?.description}</span>
              <span className="grow" />
              <button type="button" className={`org-look mono${state.lookOn ? ' is-on' : ''}`} aria-pressed={state.lookOn} onClick={() => dispatch({ type: 'toggleLook' })}>
                {state.lookOn ? `LOOK ON · ${look || 'none set'}` : 'LOOK OFF · LOG'}
              </button>
            </div>
            <div className="org-stage">
              <div className={`org-stage-frame${state.lookOn ? ' is-graded' : ''}`}>
                <Frame style={{ position: 'absolute', inset: 0, borderRadius: 2 }} />
                {take ? (
                  <>
                    <span className="org-burn-name mono">clip frame · {take.clipA}</span>
                    <span className="org-burn-tc mono">{take.tc}</span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="org-transport">
              <span className="mono org-transport-tc">{take?.tc ?? '--:--:--:--'}</span>
              <span className="grow" />
              <button type="button" className="org-tbtn mono" aria-label="Previous take" disabled={!take || shown.indexOf(take) <= 0} onClick={() => move(-1)}>
                |◀
              </button>
              <button type="button" className="org-tbtn mono" aria-label="Step back" disabled title="Playback arrives with the media engine">
                ◀
              </button>
              <button type="button" className="org-tbtn is-play mono" aria-label="Play" disabled title="Playback arrives with the media engine">
                ▶
              </button>
              <button type="button" className="org-tbtn mono" aria-label="Next take" disabled={!take || shown.indexOf(take) >= shown.length - 1} onClick={() => move(1)}>
                ▶|
              </button>
              <span className="grow" />
              <span className="mono muted org-transport-dur">{take?.duration ?? ''}</span>
            </div>
          </section>

          <aside className="org-clip-info" aria-label="Clip info">
            <div className="org-bar">
              <strong>Clip info</strong>
            </div>
            {take ? (
              <dl>
                {info.map(([label, value, status]) => (
                  <div key={label} className="org-info-row">
                    <dt className="muted">{label}</dt>
                    <dd className="mono" style={status ? { color: status === 'vfx' ? stepVar('vfx') : statusVar(status) } : undefined}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="org-info-notes muted">No take selected.</p>
            )}
            {scene?.notes ? <p className="org-info-notes">{scene.notes}</p> : null}
          </aside>
        </div>

        <section className="org-pool" aria-label="Media pool">
          <div className="org-bar">
            <strong>Media pool</strong>
            <span className="mono muted ellipsis">
              01_CAMERA_ORIGINALS / SCENE_{pad3(sceneId)} / SETUP_{setupId}
            </span>
            <span className="grow" />
            <span className="muted nowrap">Every take kept — bins are views</span>
          </div>
          {shown.length === 0 ? (
            <div className="org-pool-empty">
              <p>
                {!setup
                  ? "No takes yet. Import the script supervisor's log in Project setup: its takes are laid out here by scene and setup."
                  : takes.length === 0
                    ? `Setup ${setupId} has no takes yet.`
                    : `No ${bin.label.toLowerCase()} in Scene ${sceneId} / Setup ${setupId}. All ${takes.length} takes are still kept.`}
              </p>
              {takes.length > 0 ? (
                <button type="button" className="btn small" onClick={() => dispatch({ type: 'setPoolFilter', filter: 'all' })}>
                  Show all clips
                </button>
              ) : null}
            </div>
          ) : (
            <div className="org-pool-grid" ref={pool} onKeyDown={onPoolKey} role="group" aria-label="Takes — use the arrow keys to move between them">
              {shown.map((item) => {
                const selected = item === take;
                const [syncWord, syncStatus] = SYNC[item.sync];
                const matchStatus = MATCH[item.match][1];
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="org-thumb"
                    data-take={item.id}
                    aria-pressed={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => dispatch({ type: 'selectTake', take: item.id })}
                  >
                    <span className="org-thumb-frame">
                      <Frame style={{ position: 'absolute', inset: 0, borderRadius: 4 }} />
                      <span className="org-badge is-take mono">{item.take}</span>
                      {item.circle ? <span className="org-badge is-select">◎ SELECT</span> : null}
                      {item.vfx ? <span className="org-badge is-vfx mono">VFX</span> : null}
                      <span className="org-sync-dot" style={{ background: statusVar(syncStatus) } as CSSProperties} title={`Sync: ${syncWord}`} aria-label={`Sync: ${syncWord}`} />
                    </span>
                    <span className="org-thumb-foot">
                      <span className="mono ellipsis">{item.clipA}</span>
                      <span className="mono" style={{ color: matchStatus === 'done' ? 'var(--muted)' : statusVar(matchStatus) }} title={`Script match: ${MATCH[item.match][0]}`}>
                        {item.duration}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * The scene folders on the drives: every verified clip linked under
 * CAMERA_ORIGINALS/_BY_SCENE by its take (and circle takes under
 * SELECTS_CIRCLE_TAKES), following the log as it changes.
 */
function SceneFolders() {
  const { state } = useStore();
  const organize = state.organize!;
  const api = projectApi();
  const status: Status = organize.failed > 0 ? 'problem' : organize.activity || organize.pending > 0 ? 'working' : organize.placed > 0 ? 'done' : 'idle';
  return (
    <div className="org-bin-group" aria-label="Scene folders">
      <div className="label org-bin-title">Scene folders</div>
      <p className="org-folders small" style={tone(statusVar(status))}>
        <span className="dot" aria-hidden="true" />{' '}
        {organize.activity ??
          (organize.placed === 0 && organize.pending === 0
            ? 'Clips appear here by scene once their cards are verified.'
            : `${organize.placed} clip${organize.placed === 1 ? '' : 's'} placed${organize.pending ? ` · ${organize.pending} to place` : ''}`)}
      </p>
      {organize.references > 0 ? (
        <p className="org-folders small muted">{organize.references} as reference files: that drive cannot hold links.</p>
      ) : null}
      {organize.problems.map((problem) => (
        <p key={`${problem.clip}|${problem.destination}`} className="org-folders small" style={{ color: statusVar('problem') }}>
          {problem.clip} on {problem.destination}: {problem.error}
        </p>
      ))}
      {organize.folders.map((folder) => (
        <button key={folder.path} type="button" className="org-bin" title={folder.path} onClick={() => void api?.showSceneFolder(folder.path)}>
          <span className="grow">Open on {folder.destination}</span>
          <span className="mono muted">↗</span>
        </button>
      ))}
    </div>
  );
}
