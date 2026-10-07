import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import { LUT_SCOPES, type LutScope, type ProjectResult } from '../../shared/project';
import { projectApi } from '../state/engine';
import { useStore } from '../state/store';
import { ScreenHeader, StatusText, statusVar, tone } from '../ui/kit';
import './output.css';

/**
 * Looks: the production's LUT library, a split preview (viewing look against
 * the LOG original) and the rules that decide which LUT a clip gets. Spec
 * §4.7: a LUT applies to viewing and dailies only; camera originals are never
 * baked, and the look's name is recorded in metadata and reports. In the
 * desktop app the LUTs live in the production file and the preview is a real
 * frame through the real LUT (FFmpeg).
 */

const SCOPE_HINT: Record<LutScope, string> = {
  Project: 'Default',
  Camera: 'Camera letter, e.g. B',
  Day: 'Day number, e.g. 14',
  Scene: 'Scene, e.g. 21',
  Setup: 'Scene/setup, e.g. 14/B',
  Clip: 'Clip, e.g. A015C002',
};

export function Looks() {
  const { state, dispatch } = useStore();
  const stage = useRef<HTMLDivElement>(null);
  const lut = state.luts[state.selectedLut] ?? state.luts[0];
  const api = state.project ? projectApi() : null;
  const [notice, setNotice] = useState<string | null>(null);
  const [clipId, setClipId] = useState('');
  const [frames, setFrames] = useState<{ original: string; graded: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [rule, setRule] = useState<{ scope: LutScope; target: string }>({ scope: 'Camera', target: '' });

  const act = (call: Promise<ProjectResult>) =>
    void call.then((result) => {
      if (result.ok) {
        setNotice(null);
        dispatch({ type: 'projectState', project: result.state });
      } else if (result.reason) setNotice(result.reason);
    });

  // The real preview: the chosen clip's middle frame, as shot and through the selected LUT.
  const previewClip = clipId || state.previewClips[0]?.id || '';
  useEffect(() => {
    if (!api || !previewClip || !state.ffmpeg) return undefined;
    let live = true;
    setLoading(true);
    void api.previewLook(previewClip, lut?.id ?? null).then((result) => {
      if (!live) return;
      setLoading(false);
      if (result.ok) setFrames({ original: result.original, graded: result.graded });
      else {
        setFrames(null);
        setNotice(result.reason);
      }
    });
    return () => {
      live = false;
    };
  }, [api, previewClip, lut?.id, state.ffmpeg]);

  const splitAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    dispatch({ type: 'setSplit', split: Math.round(((event.clientX - box.left) / box.width) * 100) });
  };

  const addRule = (event: FormEvent) => {
    event.preventDefault();
    if (!api || !lut?.id || !rule.target.trim()) return;
    act(api.setLutRule(rule.scope, rule.target, lut.id));
    setRule({ ...rule, target: '' });
  };

  const previewTitle = api
    ? (state.previewClips.find((clip) => clip.id === previewClip)?.label ?? 'No clips today yet')
    : 'A014C018 · Sc 14 / B / T3';

  return (
    <div className="screen out">
      <ScreenHeader
        step="output"
        eyebrow="06 · Output · Looks"
        title="Production looks"
        description="LUTs apply to viewing and dailies only. Camera originals are never baked."
        actions={
          <button
            type="button"
            className="btn tall"
            title="Adds .cube or .3dl LUTs to this production's library"
            onClick={() => (api ? act(api.importLuts()) : undefined)}
            disabled={!api && Boolean(state.project)}
          >
            Import LUT…
          </button>
        }
      />
      {notice ? (
        <p className="looks-notice" role="alert" style={tone(statusVar('problem'))}>
          {notice}
        </p>
      ) : null}

      <div className="looks-layout">
        <section className="card">
          <div className="card-head">
            <h3>Library · {state.production.name}</h3>
          </div>
          {state.luts.length === 0 ? <p className="muted looks-empty">No LUTs yet. Import the production&apos;s .cube or .3dl files.</p> : null}
          <div role="listbox" aria-label="LUT library">
            {state.luts.map((item, index) => (
              <button
                key={item.id ?? item.name}
                type="button"
                role="option"
                aria-selected={index === state.selectedLut}
                className="lut-item"
                onClick={() => dispatch({ type: 'selectLut', index })}
              >
                <span className="mono">{item.name}</span>
                {item.isDefault ? <span className="lut-default">Project default</span> : null}
                <span className="muted">{item.description}</span>
              </button>
            ))}
          </div>
          {api && lut?.id ? (
            <div className="row looks-lut-actions">
              <button type="button" className="btn small" disabled={lut.isDefault} onClick={() => act(api.setLutRule('Project', 'Default', lut.id!))}>
                Make project default
              </button>
              <button type="button" className="btn small" title="Removes it from the library, with its rules" onClick={() => act(api.removeLut(lut.id!))}>
                Remove
              </button>
            </div>
          ) : null}
        </section>

        <div className="stack gap-20">
          <section className="card card-body stack">
            <div className="row">
              <h3 className="card-title grow">Preview · {previewTitle}</h3>
              {api && state.previewClips.length > 1 ? (
                <select className="select looks-clip" aria-label="Preview clip" value={previewClip} onChange={(event) => setClipId(event.target.value)}>
                  {state.previewClips.map((clip) => (
                    <option key={clip.id} value={clip.id}>
                      {clip.label}
                    </option>
                  ))}
                </select>
              ) : null}
              <span className="mono muted small">{lut?.name}</span>
            </div>
            <div
              ref={stage}
              className="look-stage"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture?.(event.pointerId);
                splitAt(event);
              }}
              onPointerMove={(event) => {
                if (event.buttons === 1) splitAt(event);
              }}
            >
              {frames ? (
                <>
                  <img className="look-frame" src={frames.original} alt="The clip as shot (LOG)" />
                  {frames.graded ? (
                    <>
                      <img className="look-frame graded" src={frames.graded} alt="The clip through the look" style={{ clipPath: `inset(0 ${100 - state.split}% 0 0)` }} />
                      <div className="look-split" style={{ left: `${state.split}%` }} aria-hidden="true" />
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="look-original" />
                  <div className="look-graded" style={{ width: `${state.split}%` }} />
                </>
              )}
              <span className="stage-tag left">VIEWING LOOK</span>
              <span className="stage-tag right">LOG · ORIGINAL</span>
              {!frames ? (
                <span className="stage-tag centre">
                  {!api
                    ? 'clip frame'
                    : !state.ffmpeg
                      ? 'FFmpeg is not available for previews'
                      : loading
                        ? 'Reading a frame…'
                        : state.previewClips.length === 0
                          ? 'No clips today yet'
                          : 'No preview'}
                </span>
              ) : null}
            </div>
            <input
              type="range"
              className="split-range"
              min={0}
              max={100}
              value={state.split}
              aria-label="Split between viewing look and original"
              onChange={(event) => dispatch({ type: 'setSplit', split: Number(event.target.value) })}
            />
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Assignment rules</h3>
              <span className="muted small">Most specific rule wins: clip, setup, scene, day, camera, then project</span>
            </div>
            <table className="grid">
              <tbody>
                {state.lutRules.map((item) => (
                  <tr key={`${item.scope}-${item.target}`}>
                    <td className="label rule-scope">{item.scope}</td>
                    <td className="strong-500">{item.target}</td>
                    <td className="mono muted">{item.lut}</td>
                    <td className="mono right">
                      {item.clips} clip{item.clips === 1 ? '' : 's'}
                    </td>
                    {api && item.id !== undefined ? (
                      <td className="right">
                        <button type="button" className="btn ghost small" aria-label={`Remove the ${item.scope} rule for ${item.target}`} onClick={() => act(api.removeLutRule(item.id!))}>
                          ×
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
            {api && lut?.id ? (
              <form className="row looks-rule-form" onSubmit={addRule}>
                <select className="select" aria-label="Rule applies to" value={rule.scope} onChange={(event) => setRule({ ...rule, scope: event.target.value as LutScope })}>
                  {LUT_SCOPES.filter((scope) => scope !== 'Project').map((scope) => (
                    <option key={scope}>{scope}</option>
                  ))}
                </select>
                <input className="input grow" aria-label="Rule target" placeholder={SCOPE_HINT[rule.scope]} value={rule.target} onChange={(event) => setRule({ ...rule, target: event.target.value })} />
                <button type="submit" className="btn" disabled={!rule.target.trim()}>
                  Use {lut.name.replace(/\.(cube|3dl)$/i, '')}
                </button>
              </form>
            ) : null}
            {api && state.lutRules.length === 0 ? (
              <p className="muted small looks-empty">
                <StatusText status="idle" word="No rules" /> Import a LUT: the first becomes the project default.
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
