import { useEffect } from 'react';
import { DEFAULT_PREFS, FILES_WIDTH, useStore, type IconSize, type ThemeChoice } from '../state/store';
import { DeviceIcon, ICON_PX } from '../ui/media-icons';
import { UpdateCheck } from '../ui/UpdateNotice';

/**
 * This computer's preferences (kept on it, not in the production): the
 * theme, how big drive, card and folder icons are drawn, and how wide the
 * Files panel is. Opened from the header, or ⌘, / Ctrl+,.
 */

const SIZES: { value: IconSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

export function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const { prefs } = state;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog prefs" role="dialog" aria-modal="true" aria-labelledby="prefs-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="prefs-title">Preferences</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Kept on this computer.
        </p>

        <div className="field">
          <span className="label">Theme</span>
          <div className="prefs-seg" role="group" aria-label="Theme">
            {(['dark', 'light', 'system'] as ThemeChoice[]).map((theme) => (
              <button key={theme} type="button" aria-pressed={state.theme === theme} onClick={() => dispatch({ type: 'setTheme', theme })}>
                {theme === 'system' ? 'Auto' : theme === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="label">Icon size</span>
          <div className="prefs-sizes" role="radiogroup" aria-label="Icon size">
            {SIZES.map((size) => (
              <button
                key={size.value}
                type="button"
                role="radio"
                aria-checked={prefs.iconSize === size.value}
                className={`prefs-size${prefs.iconSize === size.value ? ' picked' : ''}`}
                onClick={() => dispatch({ type: 'setPrefs', prefs: { iconSize: size.value } })}
              >
                <span className="prefs-size-icons">
                  <DeviceIcon look={{ kind: 'card', service: null }} size={Math.round(ICON_PX[size.value].tile * 0.6)} />
                  <DeviceIcon look={{ kind: 'raid', service: null }} size={Math.round(ICON_PX[size.value].tile * 0.6)} />
                </span>
                <span>{size.label}</span>
              </button>
            ))}
          </div>
          <span className="faint small">Drive, card and folder icons: in Intake, and the folders in the Files panel.</span>
        </div>

        <label className="field">
          <span className="label">
            Files panel width <span className="mono faint">{prefs.filesWidth}px</span>
          </span>
          <input
            type="range"
            min={FILES_WIDTH.min}
            max={FILES_WIDTH.max}
            step={10}
            value={prefs.filesWidth}
            aria-label="Files panel width"
            onChange={(event) => dispatch({ type: 'setPrefs', prefs: { filesWidth: Number(event.target.value) } })}
          />
          <span className="faint small">Or drag the panel's left edge. Double-click the edge to go back to {FILES_WIDTH.default}px.</span>
        </label>

        <UpdateCheck />

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="btn ghost" onClick={() => dispatch({ type: 'setPrefs', prefs: DEFAULT_PREFS })}>
            Reset to defaults
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
