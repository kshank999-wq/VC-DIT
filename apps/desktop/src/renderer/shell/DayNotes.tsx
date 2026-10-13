import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { DayNote } from '../../shared/project';
import { useStore } from '../state/store';
import { clock, rateOfProduction, stampAt, useTimecode, type Stamp, type TcSource } from '../timecode/clock';
import { statusVar } from '../ui/kit';
import './day-notes.css';

/**
 * The toolbar's timecode and notes. The DIT jots a note whenever something
 * happens (a card fails, wind on the roof, a boom in shot) and it is stamped
 * with the station's timecode from the sync box, like the script
 * supervisor's in VC Film Studio, and tied to a shot or to the day. The notes
 * go out with the day log to VC Film Studio.
 */

const SOURCE_LABEL: Record<TcSource, string> = { ltc: 'Sync box (LTC on an audio input)', jam: 'Jam by hand', clock: "This computer's clock" };
const STAMP_WORD: Record<Stamp['source'], string> = { ltc: 'LIVE', 'free-run': 'FREE RUN', jam: 'JAM', clock: 'CLOCK' };

/** A panel under a toolbar button; Escape or a click elsewhere closes it. */
function Popover({ open, onClose, label, children, wide }: { open: boolean; onClose: () => void; label: string; children: ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: MouseEvent) => {
      if (box.current && !box.current.parentElement?.contains(event.target as Node)) onClose();
    };
    const escape = (event: globalThis.KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={box} className={`tb-popover${wide ? ' wide' : ''}`} role="dialog" aria-label={label}>
      {children}
    </div>
  );
}

/** The station's timecode, ticking; how it is held decides its colour and word. */
const useTicking = () => {
  const tc = useTimecode();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 40);
    return () => clearInterval(timer);
  }, []);
  return { tc, stamp: stampAt(now, tc) };
};

export function TimecodeButton() {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const { tc, stamp } = useTicking();
  const [typed, setTyped] = useState('');
  const [jamError, setJamError] = useState<string | null>(null);

  // The production's rate is what the clock counts in.
  useEffect(() => void clock.setRate(rateOfProduction(state.production.frameRate)), [state.production.frameRate]);
  useEffect(() => {
    if (open) clock.listDevices();
  }, [open]);

  const tone = stamp.source === 'ltc' ? 'done' : stamp.source === 'clock' ? 'idle' : 'needs';
  const jam = (event: FormEvent) => {
    event.preventDefault();
    const problem = clock.jam(typed);
    setJamError(problem);
    if (!problem) setTyped('');
  };

  return (
    <div className="tb-anchor">
      <button
        type="button"
        className="tc-button mono"
        aria-expanded={open}
        title="Station timecode: where it comes from"
        onClick={() => setOpen(!open)}
        style={{ ['--tone' as string]: statusVar(tone) }}
      >
        <span className="tc-lamp" aria-hidden="true" />
        <span className="tc-value">{stamp.tc ?? '--:--:--:--'}</span>
        <span className="tc-word">{STAMP_WORD[stamp.source]}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Timecode">
        <div className="tb-head">
          <strong>Timecode</strong>
          <span className="mono muted">{tc.rateKey} fps</span>
        </div>
        <div className="stack gap-8" role="radiogroup" aria-label="Timecode source">
          {(Object.keys(SOURCE_LABEL) as TcSource[]).map((source) => (
            <label key={source} className="tc-source">
              <input type="radio" name="tc-source" checked={tc.source === source} onChange={() => clock.setSource(source)} />
              {SOURCE_LABEL[source]}
            </label>
          ))}
        </div>
        {tc.source === 'ltc' ? (
          <div className="stack gap-8 tc-section">
            <label className="field">
              <span className="label">Audio input the sync box is plugged into</span>
              <select className="select" aria-label="Audio input" value={tc.deviceId} onChange={(event) => clock.setDevice(event.target.value)} disabled={tc.listening}>
                <option value="">Default input</option>
                {tc.devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="row gap-8">
              {tc.listening ? (
                <button type="button" className="btn small" onClick={() => clock.stop()}>
                  Stop listening
                </button>
              ) : (
                <button type="button" className="btn small primary" onClick={() => void clock.start()}>
                  Listen
                </button>
              )}
              {tc.listening ? (
                <span className="tc-meter" title="Input level: it moves when the cable carries a signal" aria-label={`Input level ${Math.round(tc.level * 100)}%`}>
                  <span style={{ width: `${Math.min(100, tc.level * 100)}%` }} />
                </span>
              ) : null}
            </div>
            {tc.health ? (
              <p className="small" style={{ color: statusVar(tc.health.state === 'locked' ? 'done' : tc.health.state === 'lost' ? 'needs' : 'problem') }}>
                <strong>{tc.health.state.toUpperCase()}</strong> · {tc.health.says}
              </p>
            ) : (
              <p className="small muted">Run a cable from the box&apos;s timecode out to an audio input (a USB audio adapter works), choose it, and press Listen.</p>
            )}
          </div>
        ) : null}
        {tc.source === 'jam' ? (
          <form className="stack gap-8 tc-section" onSubmit={jam}>
            <label className="field">
              <span className="label">Type what the box shows, press Jam at that instant</span>
              <input className="input mono" aria-label="Timecode to jam" placeholder="14:05:40:12" value={typed} onChange={(event) => setTyped(event.target.value)} />
            </label>
            <button type="submit" className="btn small" disabled={!typed.trim()}>
              Jam
            </button>
            {jamError ? <p className="small" style={{ color: statusVar('problem') }}>{jamError}</p> : null}
          </form>
        ) : null}
        {tc.source === 'clock' ? (
          <p className="small muted tc-section">Time of day from this computer. Right only if the cameras run time of day too; notes say it came from the clock.</p>
        ) : null}
        {tc.error ? (
          <p className="small" role="alert" style={{ color: statusVar('problem') }}>
            {tc.error}
          </p>
        ) : null}
      </Popover>
    </div>
  );
}

// ------------------------------------------------ notes

const about = (note: Pick<DayNote, 'scope' | 'scene' | 'setup' | 'take' | 'clip'>) =>
  note.scope === 'shot'
    ? [note.scene && `Sc ${note.scene}`, note.setup && `Setup ${note.setup}`, note.take && `T${note.take.padStart(2, '0')}`, note.clip].filter(Boolean).join(' · ') || 'A shot'
    : 'General';

const SHOT_OTHER = '__other';

export function NoteButton() {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [stamp, setStamp] = useState<Stamp | null>(null);
  const [text, setText] = useState('');
  const [shot, setShot] = useState('');
  const [other, setOther] = useState({ scene: '', setup: '', take: '' });
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const takes = state.scenes.flatMap((scene) =>
    scene.setups.flatMap((setup) =>
      setup.takes.map((take) => ({
        value: `${scene.id}|${setup.id}|${String(Number(take.take.replace(/\D/g, '')) || take.take)}|${take.clipA === '—' ? '' : take.clipA}`,
        label: `${scene.id}${setup.id}-${take.take.replace(/^T/, '')}${take.clipA !== '—' ? ` · ${take.clipA}` : ''}`,
      })),
    ),
  );

  /** Open the note box: the timecode is taken now, when something was seen, not when the typing ends. */
  const begin = () => {
    setStamp(stampAt(Date.now()));
    setOpen(true);
    const selected = state.selectedTake ? takes.find((take) => take.value.startsWith(state.selectedTake!.split('|').slice(0, 2).join('|'))) : undefined;
    setShot(state.screen === 'scenes' && selected ? selected.value : '');
    setTimeout(() => field.current?.focus(), 0);
  };

  // Ctrl/⌘ + Shift + N from anywhere.
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        begin();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim() || !stamp) return;
    const [scene = '', setup = '', take = '', clip = ''] = shot === SHOT_OTHER ? [other.scene, other.setup, other.take, ''] : shot ? shot.split('|') : [];
    dispatch({
      type: 'addNote',
      note: {
        tc: stamp.tc,
        tcSource: stamp.tc ? stamp.source : 'none',
        rate: stamp.rate,
        at: new Date().toISOString(),
        scope: shot ? 'shot' : 'general',
        scene: scene.toUpperCase(),
        setup: setup.toUpperCase(),
        take,
        clip,
        text: text.trim(),
        screen: state.screen,
      },
    });
    setText('');
    setOther({ scene: '', setup: '', take: '' });
    setStamp(stampAt(Date.now()));
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
  };

  const notes = [...state.notes].reverse();

  return (
    <div className="tb-anchor">
      <button type="button" className="btn" aria-expanded={open} title="Make a timecoded note (Ctrl/⌘ Shift N)" onClick={() => (open ? setOpen(false) : begin())}>
        + Note
        {state.notes.length ? <span className="mono note-count">{state.notes.length}</span> : null}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} label="Day notes" wide>
        <form className="stack gap-8" onSubmit={save}>
          <div className="tb-head">
            <strong>Note</strong>
            <span className="mono note-stamp" title="The timecode this note is stamped with">
              {stamp?.tc ?? 'No timecode'} {stamp ? <span className="tc-word">{STAMP_WORD[stamp.source]}</span> : null}
            </span>
            <button type="button" className="link small" onClick={() => setStamp(stampAt(Date.now()))}>
              Stamp now
            </button>
          </div>
          <textarea
            ref={field}
            className="input note-text"
            aria-label="Note"
            rows={3}
            placeholder="What happened? (Ctrl/⌘ Enter saves)"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={keys}
          />
          <div className="row gap-8 wrap">
            <select className="select grow" aria-label="Note is about" value={shot} onChange={(event) => setShot(event.target.value)}>
              <option value="">General note</option>
              {takes.map((take) => (
                <option key={take.value} value={take.value}>
                  {take.label}
                </option>
              ))}
              <option value={SHOT_OTHER}>A shot not listed…</option>
            </select>
            {shot === SHOT_OTHER ? (
              <>
                {(['scene', 'setup', 'take'] as const).map((key) => (
                  <input
                    key={key}
                    className="input mono note-shot"
                    aria-label={key[0]!.toUpperCase() + key.slice(1)}
                    placeholder={key[0]!.toUpperCase() + key.slice(1)}
                    value={other[key]}
                    onChange={(event) => setOther({ ...other, [key]: event.target.value })}
                  />
                ))}
              </>
            ) : null}
            <button type="submit" className="btn primary" disabled={!text.trim()}>
              Save note
            </button>
          </div>
        </form>

        <div className="note-list" aria-label="Today's notes">
          {notes.length === 0 ? <p className="small muted">No notes today yet.</p> : null}
          {notes.map((note) => (
            <div key={note.id} className="note-row">
              <div className="row gap-8 note-meta">
                <span className="mono">{note.tc ?? '—'}</span>
                {note.tc ? <span className="tc-word">{STAMP_WORD[note.tcSource === 'none' ? 'clock' : note.tcSource]}</span> : null}
                <span className="muted grow">{about(note)}</span>
                <button type="button" className="link small" onClick={() => setEditing({ id: note.id, text: note.text })}>
                  Edit
                </button>
                {deleting === note.id ? (
                  <button
                    type="button"
                    className="link small danger"
                    onClick={() => {
                      dispatch({ type: 'removeNote', id: note.id });
                      setDeleting(null);
                    }}
                  >
                    Delete it
                  </button>
                ) : (
                  <button type="button" className="link small" aria-label={`Delete the note at ${note.tc ?? note.at}`} onClick={() => setDeleting(note.id)}>
                    Delete
                  </button>
                )}
              </div>
              {editing?.id === note.id ? (
                <form
                  className="stack gap-8"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (editing.text.trim()) dispatch({ type: 'updateNote', id: note.id, patch: { text: editing.text.trim() } });
                    setEditing(null);
                  }}
                >
                  <textarea className="input note-text" aria-label="Edit note" rows={2} value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
                  <div className="row gap-8">
                    <button type="submit" className="btn small">
                      Save
                    </button>
                    <button type="button" className="btn ghost small" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <p className="note-body">{note.text}</p>
              )}
            </div>
          ))}
        </div>
      </Popover>
    </div>
  );
}
