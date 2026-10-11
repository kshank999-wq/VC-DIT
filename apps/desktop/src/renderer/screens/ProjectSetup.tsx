import { useState, type FormEvent } from 'react';
import { NAMING_FIELDS, applyNaming, parseNaming, type ProjectResult } from '../../shared/project';
import type { ChecksumMethod, SceneStatus, Status } from '../model/types';
import { projectApi } from '../state/engine';
import { useStore } from '../state/store';
import { ScreenHeader, StatusText, statusVar, stepVar, tone } from '../ui/kit';
import './ingest.css';

/**
 * Project setup: what is set once per production (name, frame rate, the
 * default checksum, cameras and sound), the shoot day and its scene list,
 * the naming template and the script supervisor's log. In the desktop app
 * it all lives in the production's database file (src/main/db), and this is
 * where productions and days are made, opened and saved. Spec rule shown
 * here: original camera filenames are never rewritten; scene/setup/take
 * mapping lives in the media index (spec §4.4).
 */

const CHECKSUMS: ChecksumMethod[] = ['xxHash64', 'MD5', 'SHA-1'];
const FRAME_RATES = ['23.976 fps', '24 fps', '25 fps', '29.97 fps', '30 fps', '48 fps', '50 fps', '59.94 fps', '60 fps'];
const SCENE_STATUSES: SceneStatus[] = ['Scheduled', 'Shooting', 'Shot', 'Dropped'];
const SCENE_TONE: Record<SceneStatus, Status> = { Scheduled: 'idle', Shooting: 'working', Shot: 'done', Dropped: 'needs' };
const OPEN_ANOTHER = '__open';

/** "Morgan Reyes" → "MR". */
const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase())
    .join('')
    .slice(0, 3);

export function ProjectSetup() {
  const { state, dispatch } = useStore();
  const { production, day, scriptLog } = state;
  const [sceneId, setSceneId] = useState('');
  const [sceneDescription, setSceneDescription] = useState('');
  const [device, setDevice] = useState({ slot: '', name: '', format: '' });
  const [notice, setNotice] = useState<string | null>(null);
  const pad3 = (n: number) => String(n).padStart(3, '0');
  const api = state.project ? projectApi() : null;
  /** Opening, making or saving a production or a day: the database answers with the new state, or why not. */
  const act = (call: Promise<ProjectResult>) =>
    void call.then((result) => {
      if (result.ok) {
        setNotice(null);
        dispatch({ type: 'projectState', project: result.state });
      } else if (result.reason) setNotice(result.reason);
    });

  const addDevice = (event: FormEvent) => {
    event.preventDefault();
    if (!device.name.trim()) return;
    const slot = device.slot.trim().toUpperCase() || String.fromCharCode(65 + production.devices.length);
    dispatch({ type: 'setProduction', patch: { devices: [...production.devices, { slot, name: device.name.trim(), format: device.format.trim() }] } });
    setDevice({ slot: '', name: '', format: '' });
  };

  const sceneTaken = state.scenes.some((scene) => scene.id === sceneId.trim().toUpperCase());
  const addScene = (event: FormEvent) => {
    event.preventDefault();
    if (!sceneId.trim() || sceneTaken) return;
    dispatch({ type: 'addScene', id: sceneId, description: sceneDescription });
    setSceneId('');
    setSceneDescription('');
  };

  // Matched / Review the same way the flow bar counts them (status.ts summarize).
  const review = state.matches.filter((match) => match.resolution === null).length;
  const matched = scriptLog.entries - review;

  // A sample take, to show what the template and the folder layout produce.
  const sample = { scene: '14', setup: 'B', take: '04', clip: 'A014C018' };
  const exampleName = applyNaming(production.namingTokens, { prod: production.code || 'PROD', day: day.number, ...sample }) || sample.clip;
  const folders = [
    production.name || 'PRODUCTION',
    `SHOOT_DAY_${pad3(day.number)}_${day.date}`,
    'CAMERA_ORIGINALS',
    '_BY_SCENE',
    `SCENE_${sample.scene.padStart(3, '0')}`,
    `SETUP_${sample.setup}`,
    exampleName,
  ];

  return (
    <div className="screen setup">
      <ScreenHeader
        eyebrow="Project setup"
        title="Production settings"
        description="Saved per production — you set this up once, not every card."
        actions={
          <div className="row setup-actions">
            {api && state.project ? (
              <>
                <select
                  className="select"
                  aria-label="Open production"
                  value={state.project.file}
                  onChange={(event) => act(event.target.value === OPEN_ANOTHER ? api.open() : api.open(event.target.value))}
                >
                  {state.project.recent.map((item) => (
                    <option key={item.file} value={item.file}>
                      {item.file === state.project!.file ? production.name || item.name : item.name}
                    </option>
                  ))}
                  <option value={OPEN_ANOTHER}>Open another production…</option>
                </select>
                <button type="button" className="btn" onClick={() => act(api.create())}>
                  New production
                </button>
                <button
                  type="button"
                  className="btn"
                  title="One file holds the whole production: keep a copy with the media or hand it on"
                  onClick={() => act(api.saveCopy())}
                >
                  Save a copy…
                </button>
              </>
            ) : null}
            <span className="mono setup-saved" style={tone(statusVar('done'))}>
              ● Changes save as you type
            </span>
          </div>
        }
      />
      {notice ? (
        <p className="setup-notice" role="alert" style={tone(statusVar('problem'))}>
          <StatusText status="problem" word="Not done" /> {notice}
        </p>
      ) : null}

      <div className="setup-row">
        <section className="card" aria-labelledby="setup-production">
          <div className="card-head">
            <h3 id="setup-production">Production</h3>
          </div>
          <div className="card-body setup-fields">
            <label className="field">
              <span className="label">Production</span>
              <input className="input" value={production.name} onChange={(event) => dispatch({ type: 'setProduction', patch: { name: event.target.value } })} />
            </label>
            <label className="field">
              <span className="label">Code</span>
              <input
                className="input mono"
                value={production.code}
                maxLength={6}
                onChange={(event) => dispatch({ type: 'setProduction', patch: { code: event.target.value.toUpperCase() } })}
              />
            </label>
            <label className="field">
              <span className="label">Shoot day</span>
              <span className="row setup-day">
                {api && state.project ? (
                  <select className="select" aria-label="Open shoot day" value={day.number} onChange={(event) => act(api.openDay(Number(event.target.value)))}>
                    {state.project.days.map((candidate) => (
                      <option key={candidate.number} value={candidate.number}>
                        {pad3(candidate.number)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input className="input" value={pad3(day.number)} readOnly aria-readonly="true" title="Set by the shoot day you have open" />
                )}
                <span className="muted">of</span>
                <input
                  className="input setup-total"
                  type="number"
                  min={1}
                  aria-label="Total shoot days"
                  value={production.totalDays}
                  onChange={(event) => dispatch({ type: 'setProduction', patch: { totalDays: Math.max(1, Number(event.target.value) || 1) } })}
                />
              </span>
            </label>
            <div className="field">
              <label className="label" htmlFor="setup-date">
                Date
              </label>
              <span className="row setup-day">
                <input
                  id="setup-date"
                  className="input"
                  type="date"
                  value={day.date}
                  onChange={(event) => /^\d{4}-\d{2}-\d{2}$/.test(event.target.value) && dispatch({ type: 'setDay', patch: { date: event.target.value } })}
                />
                {api ? (
                  <button type="button" className="btn" title="Start the next shoot day: its own scene list and transfers" onClick={() => act(api.addDay())}>
                    New day
                  </button>
                ) : null}
              </span>
            </div>
            <label className="field">
              <span className="label">Locations</span>
              <input
                className="input"
                value={day.locations}
                placeholder="Hangar & Rooftop"
                onChange={(event) => dispatch({ type: 'setDay', patch: { locations: event.target.value } })}
              />
            </label>
            <label className="field">
              <span className="label">DIT</span>
              <input
                className="input"
                value={day.operator.name}
                placeholder="Your name"
                onChange={(event) => dispatch({ type: 'setDay', patch: { operator: { name: event.target.value, initials: initialsOf(event.target.value) } } })}
              />
            </label>
            <label className="field setup-notes">
              <span className="label">Day notes</span>
              <textarea
                className="input"
                rows={3}
                value={day.notes}
                placeholder="Weather, problems, who took which drive…"
                onChange={(event) => dispatch({ type: 'setDay', patch: { notes: event.target.value } })}
              />
            </label>
            <label className="field">
              <span className="label">Frame rate</span>
              <select
                className="select"
                value={production.frameRate}
                onChange={(event) => dispatch({ type: 'setProduction', patch: { frameRate: event.target.value } })}
              >
                {(FRAME_RATES.includes(production.frameRate) ? FRAME_RATES : [production.frameRate, ...FRAME_RATES]).map((rate) => (
                  <option key={rate}>{rate}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="label">Checksum default</span>
              <select
                className="select"
                value={production.checksum}
                onChange={(event) => dispatch({ type: 'setProduction', patch: { checksum: event.target.value as ChecksumMethod } })}
              >
                {CHECKSUMS.map((method) => (
                  <option key={method}>{method}</option>
                ))}
              </select>
            </label>

            <div className="field setup-span">
              <span className="label">Cameras &amp; sound</span>
              <ul className="setup-devices">
                {production.devices.map((item, index) => (
                  <li key={`${item.slot}-${index}`}>
                    <span className="setup-slot mono">{item.slot}</span>
                    <span className="grow">{item.name}</span>
                    <span className="muted mono">{item.format}</span>
                    <button
                      type="button"
                      className="btn ghost small"
                      aria-label={`Remove ${item.name}`}
                      onClick={() => dispatch({ type: 'setProduction', patch: { devices: production.devices.filter((_, i) => i !== index) } })}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <form className="setup-add setup-add-device" onSubmit={addDevice}>
                <input
                  className="input mono setup-add-slot"
                  placeholder="Slot"
                  aria-label="New device slot"
                  maxLength={3}
                  value={device.slot}
                  onChange={(event) => setDevice({ ...device, slot: event.target.value })}
                />
                <input
                  className="input"
                  placeholder="Camera or recorder"
                  aria-label="New device name"
                  value={device.name}
                  onChange={(event) => setDevice({ ...device, name: event.target.value })}
                />
                <input
                  className="input"
                  placeholder="Format (optional)"
                  aria-label="New device format"
                  value={device.format}
                  onChange={(event) => setDevice({ ...device, format: event.target.value })}
                />
                <button type="submit" className="btn" disabled={!device.name.trim()}>
                  Add
                </button>
              </form>
            </div>
          </div>
        </section>

        <section className="card" aria-labelledby="setup-scenes">
          <div className="card-head">
            <h3 id="setup-scenes">Day {pad3(day.number)} scene list</h3>
            <span className="muted">Set each scene's status</span>
          </div>
          <ul className="setup-scenes">
            {state.scenes.map((scene) => (
              <li key={scene.id} className={scene.status === 'Dropped' ? 'dropped' : undefined}>
                <span className="mono setup-scene-id">{scene.id}</span>
                <span className="grow setup-scene-desc">{scene.description}</span>
                <span className="setup-status" style={tone(statusVar(SCENE_TONE[scene.status]))}>
                  <span className="dot" />
                  <select
                    aria-label={`Scene ${scene.id} status`}
                    value={scene.status}
                    onChange={(event) => dispatch({ type: 'setSceneStatus', scene: scene.id, status: event.target.value as SceneStatus })}
                  >
                    {SCENE_STATUSES.map((status) => (
                      <option key={status}>{status}</option>
                    ))}
                  </select>
                </span>
                <button
                  type="button"
                  className="btn ghost small"
                  aria-label={`Remove scene ${scene.id}`}
                  onClick={() => dispatch({ type: 'removeScene', scene: scene.id })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          {state.scenes.length === 0 ? <p className="muted setup-empty">No scenes on today's list yet. Add the scenes being shot below.</p> : null}
          <form className="setup-add" onSubmit={addScene}>
            <input
              className="input mono setup-add-id"
              placeholder="Scene no."
              aria-label="New scene number"
              value={sceneId}
              onChange={(event) => setSceneId(event.target.value)}
            />
            <input
              className="input grow"
              placeholder="Description (optional)"
              aria-label="New scene description"
              value={sceneDescription}
              onChange={(event) => setSceneDescription(event.target.value)}
            />
            <button type="submit" className="btn" disabled={!sceneId.trim() || sceneTaken} title={sceneTaken ? 'That scene is already on the list' : undefined}>
              Add scene
            </button>
          </form>
          {sceneTaken ? <p className="why-disabled setup-add-why">Scene {sceneId.trim().toUpperCase()} is already on the list.</p> : null}
        </section>
      </div>

      <div className="setup-row wide">
        <section className="card" aria-labelledby="setup-naming">
          <div className="card-head">
            <h3 id="setup-naming">Naming template</h3>
          </div>
          <div className="card-body stack">
            <div className="setup-tokens" aria-label="Naming template tokens">
              {production.namingTokens.map((token, index) =>
                token === '_' ? (
                  <span key={index} className="setup-sep mono" aria-hidden="true">
                    _
                  </span>
                ) : (
                  <span key={index} className="setup-token mono">
                    {token}
                  </span>
                ),
              )}
            </div>
            <label className="field">
              <span className="label">Take folder name</span>
              <input
                className="input mono"
                aria-label="Naming template"
                value={production.namingTokens.join('')}
                onChange={(event) => dispatch({ type: 'setProduction', patch: { namingTokens: parseNaming(event.target.value) } })}
              />
              <span className="muted small">Fields: {NAMING_FIELDS.join(' ')}</span>
            </label>
            <div className="field">
              <span className="label">Folder preview</span>
              <div className="mono setup-preview">
                {folders.join(' / ')} / <span style={{ color: stepVar('intake') }}>A014C018_261005_R1ZK.ari</span>
              </div>
            </div>
            <p className="muted setup-note">
              The cards stay exactly as ingested, with their original file names. The scene folders and circle takes are links to the same files (or
              reference files where a drive cannot hold links), never second copies, and they follow the log as it changes.
            </p>
          </div>
        </section>

        <section className="card" aria-labelledby="setup-log">
          <div className="card-head">
            <h3 id="setup-log">Script supervisor log</h3>
            <button type="button" className="link" onClick={() => dispatch({ type: 'go', screen: 'match' })}>
              Match review →
            </button>
          </div>
          {api ? (
            <LogCard api={api} act={act} />
          ) : (
            <div className="card-body stack">
              <div className="setup-file">
                <span className="setup-csv mono">CSV</span>
                <div className="grow">
                  <div className="mono setup-file-name">{scriptLog.file}</div>
                  <div className="muted">Imported {scriptLog.importedAt} · neutral interchange schema</div>
                </div>
                <button type="button" className="btn small" onClick={() => dispatch({ type: 'reimportScriptLog' })}>
                  Re-import
                </button>
              </div>
              <div className="setup-stats">
                <Stat value={scriptLog.entries} label="Entries" />
                <Stat value={matched} label="Matched" color={statusVar('done')} />
                <Stat value={review} label="Review" color={statusVar(review > 0 ? 'needs' : 'done')} />
                <Stat value={scriptLog.vfxFlags} label="VFX flags" color={stepVar('vfx')} />
              </div>
              {review > 0 ? <StatusText status="needs" word={`${review} entr${review === 1 ? 'y needs' : 'ies need'} a decision in Match review`} /> : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** The day's log in the desktop app: import (or re-import) it, see how it matched, and what was not understood. */
function LogCard({ api, act }: { api: ProjectApi; act: (call: Promise<ProjectResult>) => void }) {
  const { state } = useStore();
  const [importing, setImporting] = useState(false);
  const summary = state.scriptLog.entries > 0 ? state.scriptLog : null;
  const open = state.matches.filter((match) => match.resolution === null).length;
  const run = (call: Promise<ProjectResult>) => {
    setImporting(true);
    act(call.finally(() => setImporting(false)));
  };
  return (
    <div className="card-body stack">
      {summary ? (
        <>
          <div className="setup-file">
            <span className="setup-csv mono">LOG</span>
            <div className="grow">
              <div className="mono setup-file-name">{summary.file}</div>
              <div className="muted">Imported {summary.importedAt} · matched against today&apos;s cards</div>
            </div>
            <button
              type="button"
              className="btn small"
              disabled={importing}
              onClick={() => run(api.importLog())}
              title="Import an updated log; your match decisions are kept"
            >
              Re-import
            </button>
          </div>
          <div className="setup-stats">
            <Stat value={summary.entries} label="Entries" />
            <Stat value={summary.entries - open} label="Matched" color={statusVar('done')} />
            <Stat value={open} label="Review" color={statusVar(open > 0 ? 'needs' : 'done')} />
            <Stat value={summary.vfxFlags} label="VFX flags" color={stepVar('vfx')} />
          </div>
          {open > 0 ? <StatusText status="needs" word={`${open} need${open === 1 ? 's' : ''} a decision in Match review`} /> : null}
          {summary.warnings?.length ? (
            <details className="setup-warnings">
              <summary>
                {summary.warnings.length} row{summary.warnings.length === 1 ? '' : 's'} not fully read ({summary.format})
              </summary>
              <ul>
                {summary.warnings.slice(0, 50).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : (
        <>
          <p className="muted setup-note">
            Import the script supervisor&apos;s log for today: CSV or tab-separated text, Avid ALE, JSON or XML. Columns are recognised by name (Scene, Setup,
            Take, Clip, Roll, TC In, Circle, VFX, Notes…). Each take is matched to its camera clips and sound; anything uncertain goes to Match review, and
            takes on cards not in yet are matched when the card arrives.
          </p>
          <div className="row setup-log-actions">
            <button type="button" className="btn primary" disabled={importing} onClick={() => run(api.importLog())}>
              Import log…
            </button>
            <button type="button" className="btn" onClick={() => act(api.saveLogTemplate())}>
              Save a template CSV…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ value, label, color }: { value: number; label: string; color?: string }) {
  return (
    <div className="setup-stat">
      <span className="setup-stat-value" style={color ? { color } : undefined}>
        {value}
      </span>
      <span className="muted">{label}</span>
    </div>
  );
}
