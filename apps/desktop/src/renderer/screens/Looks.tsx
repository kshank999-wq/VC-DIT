import { useRef, type PointerEvent } from 'react';
import { useStore } from '../state/store';
import { ScreenHeader } from '../ui/kit';
import './output.css';

/**
 * Looks: the production's LUT library, a split preview (viewing look against
 * the LOG original) and the rules that decide which LUT a clip gets. Spec
 * §4.7: a LUT applies to viewing and dailies only; camera originals are never
 * baked, and the look's name is recorded in metadata and reports.
 */
export function Looks() {
  const { state, dispatch } = useStore();
  const stage = useRef<HTMLDivElement>(null);
  const lut = state.luts[state.selectedLut] ?? state.luts[0];

  const splitAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    dispatch({ type: 'setSplit', split: Math.round(((event.clientX - box.left) / box.width) * 100) });
  };

  return (
    <div className="screen out">
      <ScreenHeader
        step="output"
        eyebrow="06 · Output · Looks"
        title="Production looks"
        description="LUTs apply to viewing and dailies only. Camera originals are never baked."
        actions={
          <button type="button" className="btn tall" title="Adds a .cube LUT to this production's library">
            Import LUT…
          </button>
        }
      />

      <div className="looks-layout">
        <section className="card">
          <div className="card-head">
            <h3>Library · {state.production.name}</h3>
          </div>
          <div role="listbox" aria-label="LUT library">
            {state.luts.map((item, index) => (
              <button
                key={item.name}
                type="button"
                role="option"
                aria-selected={index === state.selectedLut}
                className="lut-item"
                onClick={() => dispatch({ type: 'selectLut', index })}
              >
                <span className="mono">{item.name}</span>
                <span className="muted">{item.description}</span>
              </button>
            ))}
          </div>
        </section>

        <div className="stack gap-20">
          <section className="card card-body stack">
            <div className="row">
              <h3 className="card-title grow">Preview · A014C018 · Sc 14 / B / T3</h3>
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
              <div className="look-original" />
              <div className="look-graded" style={{ width: `${state.split}%` }} />
              <span className="stage-tag left">VIEWING LOOK</span>
              <span className="stage-tag right">LOG-C4 · ORIGINAL</span>
              <span className="stage-tag centre">clip frame</span>
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
              <span className="muted small">Most specific rule wins</span>
            </div>
            <table className="grid">
              <tbody>
                {state.lutRules.map((rule) => (
                  <tr key={`${rule.scope}-${rule.target}`}>
                    <td className="label rule-scope">{rule.scope}</td>
                    <td className="strong-500">{rule.target}</td>
                    <td className="mono muted">{rule.lut}</td>
                    <td className="mono right">
                      {rule.clips} clip{rule.clips === 1 ? '' : 's'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}
