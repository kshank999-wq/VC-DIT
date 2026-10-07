import { useState, type KeyboardEvent } from 'react';
import type { ProjectResult } from '../../shared/project';
import type { MirrorMethod, Status, VfxShot } from '../model/types';
import { projectApi } from '../state/engine';
import { useStore } from '../state/store';
import { Chip, ScreenHeader, Segmented, StartButton, statusVar, stepVar, tone } from '../ui/kit';
import './organize.css';

/**
 * VFX Handoff: every shot flagged for VFX (by the script supervisor's log or
 * a DIT tag), mirrored into VFX → Scene → Setup, and sent on to VC VFX Prep.
 *
 * Spec §4.9: mirroring never removes the editorial instance. The original
 * stays in CAMERA_ORIGINALS; the VFX folder holds a hard link, a database
 * reference or a separate copy, by the method chosen here. In the desktop
 * app the mirrors are real (src/main/vfx) and shown per destination.
 */

const PREP: Record<VfxShot['prep'], [string, Status]> = {
  eligible: ['Eligible', 'done'],
  blocked: ['Blocked · match', 'needs'],
  sent: ['Sent to prep', 'working'],
};

const METHOD_HINT: Record<MirrorMethod, string> = {
  'Hard link': 'Hard link on the same volume — no extra storage.',
  Reference: 'Database pointer only — no files are written; it resolves on export.',
  'Physical copy': 'A separate, verified copy for a standalone vendor deliverable — uses storage.',
};

const METHODS: MirrorMethod[] = ['Hard link', 'Reference', 'Physical copy'];

/** One word for where a shot stands, from its real mirrors when it has them. */
const standing = (shot: VfxShot): [string, Status] => {
  if (!shot.locations || shot.prep !== 'eligible') return PREP[shot.prep];
  if (shot.locations.length === 0) return ['No verified copy yet', 'idle'];
  if (shot.locations.some((location) => location.state === 'failed')) return ['Mirror failed', 'problem'];
  if (shot.locations.every((location) => location.state === 'mirrored')) return ['Mirrored', 'done'];
  return ['To mirror', 'idle'];
};

const mirrored = (shot: VfxShot) => !shot.locations || shot.locations.some((location) => location.state === 'mirrored');

const scenePath = (shot: VfxShot) => `SCENE_${shot.scene.padStart(3, '0')}/SETUP_${shot.setup}/${shot.clip}`;

export function VfxHandoff() {
  const { state, dispatch } = useStore();
  const [tagging, setTagging] = useState(false);
  const [clip, setClip] = useState('');
  const [note, setNote] = useState('');
  const shot = state.vfx[state.selectedVfx] ?? state.vfx[0];
  const api = state.project ? projectApi() : null;
  const [notice, setNotice] = useState<string | null>(null);
  const act = (call: Promise<ProjectResult>) =>
    void call.then((result) => {
      if (result.ok) {
        setNotice(null);
        dispatch({ type: 'projectState', project: result.state });
      } else if (result.reason) setNotice(result.reason);
    });
  const eligible = state.vfx.filter((item) => item.prep === 'eligible' && mirrored(item)).length;
  const toMirror = state.vfx.filter((item) => item.prep !== 'blocked' && item.locations?.some((location) => location.state !== 'mirrored')).length;
  const blocked = state.vfx.filter((item) => item.prep === 'blocked').length;

  const clips = state.scenes.flatMap((scene) => scene.setups.flatMap((setup) => setup.takes.flatMap((take) => (take.clipB ? [take.clipA, take.clipB] : [take.clipA]))));
  const wanted = clip.trim().toUpperCase();
  const tagReason = !wanted
    ? null
    : state.vfx.some((item) => item.clip === wanted)
      ? `${wanted} is already on the VFX list.`
      : !clips.includes(wanted)
        ? `No clip named ${wanted} in today's media.`
        : null;

  const sendReason =
    eligible > 0
      ? null
      : blocked > 0
        ? `Nothing eligible: ${blocked} shot${blocked === 1 ? '' : 's'} waiting on Match Review.`
        : state.vfx.length === 0
          ? 'No VFX shots today.'
          : state.vfx.every((item) => item.prep === 'sent')
            ? 'Every shot has been sent to prep.'
            : 'Nothing mirrored yet to send.';

  const tag = () => {
    if (!wanted || tagReason) return;
    if (api) act(api.tagVfx(wanted, note));
    else dispatch({ type: 'tagVfx', clip: wanted, note });
    dispatch({ type: 'selectVfx', index: state.vfx.length });
    setClip('');
    setNote('');
    setTagging(false);
  };

  const onRowKey = (event: KeyboardEvent, index: number) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      dispatch({ type: 'selectVfx', index });
    }
  };

  return (
    <div className="screen">
      <ScreenHeader
        step="vfx"
        eyebrow="04 · VFX"
        title="VFX-designated shots"
        description="Mirrored into VFX → Scene → Setup. Mirroring never removes the editorial instance — it always stays in place."
        actions={
          <>
            <button
              type="button"
              className="btn"
              style={{ height: 34 }}
              title="Opens Delivery, where the VFX package is sent to the vendor"
              onClick={() => dispatch({ type: 'go', screen: 'delivery' })}
            >
              Export package for vendor
            </button>
            {api ? (
              <button
                type="button"
                className="btn"
                style={{ height: 34 }}
                disabled={Boolean(state.vfxActivity) || toMirror === 0}
                title={toMirror === 0 ? 'Every shot with a verified copy is mirrored' : 'Make the missing mirrors, physical copies included, and retry any that failed'}
                onClick={() => act(api.mirrorVfx())}
              >
                {state.vfxActivity ? 'Mirroring…' : toMirror > 0 ? `Mirror ${toMirror} now` : 'All mirrored'}
              </button>
            ) : null}
            <StartButton step="vfx" disabledReason={sendReason} onClick={() => (api ? act(api.sendVfx()) : dispatch({ type: 'sendToPrep' }))}>
              {eligible > 0 ? `Send ${eligible} to VC VFX Prep` : 'Send to VC VFX Prep'}
            </StartButton>
          </>
        }
      />

      {state.vfxActivity ? (
        <p className="muted vfx-activity" role="status">
          {state.vfxActivity}
        </p>
      ) : null}
      {notice ? (
        <p className="vfx-notice" role="alert" style={tone(statusVar('problem'))}>
          {notice}
        </p>
      ) : null}
      {api && state.vfx.length === 0 ? (
        <p className="muted" role="status">
          No VFX shots today. They come from the script supervisor&apos;s log (its VFX column), or tag one below.
        </p>
      ) : null}

      <div className="vfx-layout">
        <div className="card vfx-table">
          <table className="grid">
            <colgroup>
              <col style={{ width: 120 }} />
              <col style={{ width: 96 }} />
              <col />
              <col style={{ width: 96 }} />
              <col style={{ width: 168 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Sc / Setup / T</th>
                <th>Clip</th>
                <th>VFX note</th>
                <th>Flagged by</th>
                <th>Prep</th>
              </tr>
            </thead>
            <tbody>
              {state.vfx.map((item, index) => {
                const [word, status] = standing(item);
                return (
                  <tr
                    key={item.key ?? item.clip}
                    className="clickable"
                    tabIndex={0}
                    aria-selected={item === shot}
                    onClick={() => dispatch({ type: 'selectVfx', index })}
                    onKeyDown={(event) => onRowKey(event, index)}
                  >
                    <td className="vfx-key">
                      {item.scene} / {item.setup} / T{item.take}
                    </td>
                    <td className="vfx-clip">{item.clip}</td>
                    <td className="vfx-note-cell" title={item.note}>
                      {item.note || '—'}
                    </td>
                    <td className="vfx-by">{item.flaggedBy}</td>
                    <td>
                      <span className="vfx-prep">
                        <Chip color={statusVar(status)}>{word}</Chip>
                        {item.prep === 'blocked' ? (
                          <button
                            type="button"
                            className="link"
                            onClick={(event) => {
                              event.stopPropagation();
                              dispatch({ type: 'go', screen: 'match' });
                            }}
                          >
                            Waiting on Match Review →
                          </button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {tagging ? (
            <form
              className="vfx-tag-form"
              onSubmit={(event) => {
                event.preventDefault();
                tag();
              }}
            >
              <input
                className="input mono"
                list="vfx-clips"
                placeholder="Clip, e.g. A014C020"
                aria-label="Clip"
                value={clip}
                autoFocus
                onChange={(event) => setClip(event.target.value)}
              />
              <datalist id="vfx-clips">
                {clips
                  .filter((name) => !state.vfx.some((item) => item.clip === name))
                  .map((name) => (
                    <option key={name} value={name} />
                  ))}
              </datalist>
              <input className="input" placeholder="VFX note" aria-label="VFX note" value={note} onChange={(event) => setNote(event.target.value)} />
              <button type="submit" className="btn primary small" style={tone(stepVar('vfx'), 'var(--on-step)')} disabled={!wanted || Boolean(tagReason)}>
                Tag
              </button>
              <button type="button" className="btn small" onClick={() => setTagging(false)}>
                Cancel
              </button>
              {tagReason ? <span className="why-disabled">{tagReason}</span> : null}
            </form>
          ) : (
            <button type="button" className="vfx-tag-toggle" onClick={() => setTagging(true)}>
              + Tag additional VFX candidate
            </button>
          )}
        </div>

        {shot ? (
          <aside className="card vfx-detail" aria-label="Selected shot">
            <div className="stack" style={{ gap: 4 }}>
              <h2>{shot.clip}</h2>
              <span className="muted" style={{ fontSize: 12.5 }}>
                Scene {shot.scene} · Setup {shot.setup} · Take {shot.take}
              </span>
            </div>
            {shot.note ? <p className="vfx-note">{shot.note}</p> : null}
            {shot.prep === 'blocked' ? (
              <div className="vfx-blocked">
                <span>Waiting on Match Review — this clip's script-log match isn't confirmed yet, so it can't go to prep.</span>
                <button type="button" className="link" onClick={() => dispatch({ type: 'go', screen: 'match' })}>
                  Open Match Review →
                </button>
              </div>
            ) : null}
            {shot.locations ? (
              <div className="stack" style={{ gap: 8 }}>
                <span className="label">Locations</span>
                {shot.locations.length === 0 ? (
                  <p className="org-hint">No destination has a verified copy of {shot.clip} yet. It is mirrored as soon as its card is ingested and verified.</p>
                ) : null}
                {shot.locations.map((location) => (
                  <div key={location.destination} className="stack" style={{ gap: 6 }}>
                    <div className="vfx-loc" style={tone(statusVar('done'))}>
                      <span className="label">{location.destination} · editorial original</span>
                      <span className="vfx-path">{location.editorial}</span>
                    </div>
                    <div
                      className="vfx-loc vfx-loc-mirror"
                      style={tone(location.state === 'failed' ? statusVar('problem') : location.state === 'mirrored' ? stepVar('vfx') : statusVar('idle'))}
                    >
                      <span className="label">
                        {location.destination} · VFX mirror ·{' '}
                        {location.state === 'mirrored'
                          ? location.method === 'Reference' && state.mirrorMethod === 'Hard link'
                            ? 'Reference (this drive has no hard links)'
                            : location.method
                          : location.state === 'failed'
                            ? 'Failed'
                            : 'Not yet'}
                      </span>
                      <span className="vfx-path">{location.mirror ?? (state.mirrorMethod === 'Physical copy' ? 'Copied when you press Mirror now' : 'Made automatically')}</span>
                      {location.error ? <span className="vfx-error">{location.error}</span> : null}
                    </div>
                  </div>
                ))}
                <p className="org-hint">The editorial original is never moved or removed.</p>
              </div>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                <span className="label">Locations</span>
                <div className="vfx-loc" style={tone(statusVar('done'))}>
                  <span className="label">Editorial · original</span>
                  <span className="vfx-path">…/CAMERA_ORIGINALS/{scenePath(shot)}</span>
                </div>
                <div className="vfx-loc vfx-loc-mirror" style={tone(stepVar('vfx'))}>
                  <span className="label">VFX mirror · {state.mirrorMethod}</span>
                  <span className="vfx-path">…/VFX/{scenePath(shot)}</span>
                </div>
                <p className="org-hint">The editorial original is never moved or removed.</p>
              </div>
            )}
            <div className="stack" style={{ gap: 8 }}>
              <span className="label">Mirror method</span>
              <Segmented label="Mirror method" value={state.mirrorMethod} options={METHODS} onChange={(method) => dispatch({ type: 'setMirrorMethod', method })} />
              <p className="org-hint">
                {METHOD_HINT[state.mirrorMethod]}
                {api ? ' Applies to shots not mirrored yet.' : ''}
              </p>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
