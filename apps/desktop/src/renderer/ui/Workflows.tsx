import { useEffect, useState } from 'react';
import { BRAND_NAME, type Brand } from '../../shared/brands';
import type { Workflow, WorkflowCamera } from '../../shared/media';
import type { Volume } from '../model/types';
import { engine } from '../state/engine';
import { DESTINATION_ROLES, useStore } from '../state/store';

/**
 * Saved workflows (Silverstack's presets): where a kind of card goes, with
 * which checksum, whether it starts by itself once the card and its drives
 * are in, and whether the dailies follow. Saved from what is picked now.
 */

export const CAMERA_WORD = (camera: WorkflowCamera): string => (camera === 'any' ? 'Any camera' : camera === 'sound' ? 'Sound cards' : BRAND_NAME[camera as Brand]);
const CAMERAS: WorkflowCamera[] = ['any', ...(Object.keys(BRAND_NAME) as Brand[]), 'sound'];

/** On a card: the workflow it matches, a button to use it, and why it has not started by itself. */
export function WorkflowChip({ volume }: { volume: Volume }) {
  const { state, dispatch } = useStore();
  const workflow = state.workflows.find((candidate) => candidate.id === volume.workflow);
  if (!workflow) return null;
  const note = state.autoStart[volume.id];
  const applied = state.appliedWorkflow === workflow.id;
  return (
    <div className="workflow-chip">
      <span className="small" title={`${workflow.destinations.map((destination) => destination.name).join(', ')} · ${workflow.checksum}`}>
        ⚙ {workflow.name}
        {workflow.autoStart ? <span className="faint"> · starts by itself</span> : null}
      </span>
      {volume.ingested ? null : (
        <button type="button" className="btn ghost small" aria-pressed={applied} onClick={() => dispatch({ type: 'applyWorkflow', workflow })} title="Tick its destinations and use its checksum">
          {applied ? 'Applied' : 'Apply'}
        </button>
      )}
      {note ? <span className="faint small workflow-note">{note}</span> : null}
    </div>
  );
}

export function WorkflowsButton() {
  const [open, setOpen] = useState(false);
  const { state } = useStore();
  if (!state.engine) return null;
  return (
    <>
      <button type="button" className="btn ghost small" onClick={() => setOpen(true)}>
        Workflows{state.workflows.length ? ` (${state.workflows.length})` : ''}…
      </button>
      {open && <WorkflowsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function WorkflowsDialog({ onClose }: { onClose: () => void }) {
  const { state } = useStore();
  const media = engine();
  const picked = [
    ...state.volumes.filter((volume) => DESTINATION_ROLES.includes(volume.role) && volume.included).map((volume) => ({ id: volume.id, name: volume.name })),
    ...state.destinations.filter((destination) => destination.selected).map((destination) => ({ id: destination.id, name: destination.name })),
  ];
  const used = new Set(state.workflows.map((workflow) => workflow.camera));
  const [name, setName] = useState('');
  const [camera, setCamera] = useState<WorkflowCamera>(CAMERAS.find((candidate) => !used.has(candidate)) ?? 'any');
  const [autoStart, setAutoStart] = useState(false);
  const [dailies, setDailies] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    if (!media) return;
    const result = await media.saveWorkflow({ name: name.trim() || `${CAMERA_WORD(camera)} offload`, camera, destinations: picked.map((drive) => drive.id), checksum: state.checksum, autoStart, dailies });
    if (result.ok) {
      setName('');
      setProblem(null);
    } else setProblem(result.reason);
  };
  const replaces = state.workflows.find((workflow) => workflow.camera === camera);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog workflows-dialog" role="dialog" aria-modal="true" aria-labelledby="workflows-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="workflows-title">Workflows</h2>
        {state.workflows.length ? (
          <ul className="workflow-list">
            {state.workflows.map((workflow: Workflow) => (
              <li key={workflow.id} className="row" style={{ gap: 8 }}>
                <span className="grow">
                  <span className="strong">{workflow.name}</span>
                  <span className="muted small">
                    {' '}
                    · {CAMERA_WORD(workflow.camera)} → {workflow.destinations.map((destination) => destination.name).join(', ')} · {workflow.checksum}
                    {workflow.autoStart ? ' · starts by itself' : ''}
                    {workflow.dailies ? ' · then dailies' : ''}
                  </span>
                  {workflow.missing?.length ? <span className="faint small"> · not here: {workflow.missing.join(', ')}</span> : null}
                </span>
                <button type="button" className="btn ghost small" aria-label={`Remove ${workflow.name}`} onClick={() => void media?.removeWorkflow(workflow.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">None yet. Pick the destinations and checksum for a kind of card above, then save them here.</p>
        )}

        <h3 className="small">Save what is picked now</h3>
        <p className="muted small">
          {picked.length ? `${picked.map((drive) => drive.name).join(', ')} · ${state.checksum}` : 'Tick at least one destination first.'}
        </p>
        <label className="row" style={{ gap: 8 }}>
          <span className="faint small">For</span>
          <select className="select" aria-label="Cards it is for" value={camera} onChange={(event) => setCamera(event.target.value as WorkflowCamera)}>
            {CAMERAS.map((option) => (
              <option key={option} value={option}>
                {CAMERA_WORD(option)}
              </option>
            ))}
          </select>
          <input className="input grow" aria-label="Workflow name" placeholder={`${CAMERA_WORD(camera)} offload`} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={autoStart} onChange={(event) => setAutoStart(event.target.checked)} />
          Start by itself when a card and all these drives are in
        </label>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={dailies} onChange={(event) => setDailies(event.target.checked)} />
          Render the dailies when the card has verified
        </label>
        {replaces ? <p className="faint small">Replaces {replaces.name}: one workflow for each kind of card.</p> : null}
        {problem ? <p role="alert">{problem}</p> : null}
        <div className="row clear-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn primary" disabled={!picked.length} onClick={() => void save()}>
            Save workflow
          </button>
        </div>
      </div>
    </div>
  );
}
