import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import { GRADE_LIMITS, IDENTITY_CDL, applyTable, gradeTable, isIdentityCdl, limitCdl, type Cdl, type LookTable } from '../../shared/grade';
import type { ProjectResult } from '../../shared/project';
import { testChart } from '../grade/chart';
import { scope, type ScopeKind } from '../grade/scopes';
import { projectApi } from '../state/engine';
import { useStore } from '../state/store';
import { ScreenHeader, statusVar, tone } from '../ui/kit';
import './output.css';

/**
 * Grade: a limited, on-set grade made against scopes. An ASC CDL (offset,
 * power and slope per channel, then saturation) over the production's show
 * LUT, graded live on a frame of the day's own clips, with a waveform, an RGB
 * parade, a vectorscope and a histogram of the graded picture. Saved, it is
 * a look in the library like any other: the dailies apply it (baked to a
 * .cube over the show LUT), editorial gets its CDL numbers with each clip,
 * and the camera originals are never touched.
 */

interface Frame {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

const CHART = 'chart';
const CHART_SIZE = { width: 960, height: 402 };
const chart = (): Frame => ({ ...CHART_SIZE, pixels: testChart(CHART_SIZE.width, CHART_SIZE.height) });

/** A canvas's 2D context, or null where there is none to draw on (a test's DOM). */
const context2d = (canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null => {
  if (!canvas || typeof navigator === 'undefined' || /jsdom/i.test(navigator.userAgent)) return null;
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
};

const decode = (url: string): Promise<Frame> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = context2d(canvas);
      if (!context) return reject(new Error('This display cannot read the frame\'s pixels.'));
      context.drawImage(image, 0, 0);
      resolve({ width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data });
    };
    image.onerror = () => reject(new Error('The frame could not be read.'));
    image.src = url;
  });

const through = (frame: Frame, table: LookTable): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(frame.pixels.length);
  applyTable(table, frame.pixels, out);
  return out;
};

type Wheel = 'offset' | 'power' | 'slope';

const WHEELS: { key: Wheel; label: string; also: string; hint: string; neutral: number; step: number }[] = [
  { key: 'offset', label: 'Offset', also: 'Lift', hint: 'Moves every level up or down: the blacks show it most', neutral: 0, step: 0.001 },
  { key: 'power', label: 'Power', also: 'Gamma', hint: 'Bends the mid-tones, leaving black and white where they are', neutral: 1, step: 0.005 },
  { key: 'slope', label: 'Slope', also: 'Gain', hint: 'Scales every level: the highlights show it most', neutral: 1, step: 0.005 },
];

const CHANNELS = [
  { index: 0, name: 'Red', short: 'R' },
  { index: 1, name: 'Green', short: 'G' },
  { index: 2, name: 'Blue', short: 'B' },
] as const;

const SCOPES: { kind: ScopeKind; label: string }[] = [
  { kind: 'waveform', label: 'Waveform' },
  { kind: 'parade', label: 'RGB parade' },
  { kind: 'vectorscope', label: 'Vectorscope' },
  { kind: 'histogram', label: 'Histogram' },
];

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const fixed = (value: number) => value.toFixed(3);
const stem = (name: string) => name.replace(/\.(cube|3dl|cc|ccc|cdl)$/i, '');

/** The master control of a wheel: offset moves all three channels by the same amount, power and slope scale them together. */
const setMaster = (cdl: Cdl, wheel: Wheel, value: number): Cdl => {
  const current = cdl[wheel];
  const middle = mean(current);
  const next =
    wheel === 'offset'
      ? current.map((channel) => channel + (value - middle))
      : middle > 0
        ? current.map((channel) => channel * (value / middle))
        : current.map(() => value);
  return limitCdl({ ...cdl, [wheel]: next });
};

const setChannel = (cdl: Cdl, wheel: Wheel, index: number, value: number): Cdl => {
  const next = [...cdl[wheel]] as [number, number, number];
  next[index] = value;
  return limitCdl({ ...cdl, [wheel]: next });
};

export function Grade() {
  const { state, dispatch } = useStore();
  const api = state.project ? projectApi() : null;
  const viewer = useRef<HTMLCanvasElement>(null);
  const scopeCanvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const tables = useRef(new Map<number, LookTable>());

  const defaultLut = state.luts.find((lut) => lut.isDefault);
  const initialBase = defaultLut ? (defaultLut.grade ? defaultLut.grade.baseLutId : (defaultLut.id ?? null)) : null;
  const [baseId, setBaseId] = useState<number | null>(initialBase);
  const [cdl, setCdl] = useState<Cdl>(IDENTITY_CDL);
  const [name, setName] = useState(`${state.production.code || 'Show'}_Grade_v1`);
  const [picked, setPicked] = useState('');
  const [source, setSource] = useState<Frame | null>(null);
  const [loading, setLoading] = useState(false);
  const [baseTable, setBaseTable] = useState<LookTable | null>(null);
  const [kind, setKind] = useState<ScopeKind>('waveform');
  const [split, setSplit] = useState(100);
  const [notice, setNotice] = useState<{ text: string; problem: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const shownCdl = useDeferredValue(cdl);
  const bases = state.luts.filter((lut) => lut.id !== undefined && !lut.grade);
  const startingPoints = state.luts.filter((lut) => lut.sop);
  const baseLut = baseId === null ? null : state.luts.find((lut) => lut.id === baseId);
  // The first clip of the day until another (or the chart) is picked.
  const clipId = picked === CHART ? '' : picked || (state.previewClips[0]?.id ?? '');
  const onChart = !api || !clipId || !state.ffmpeg;

  // The frame to grade: the chosen clip's middle frame as shot (LOG), or the test chart.
  useEffect(() => {
    if (onChart) {
      setSource(chart());
      return undefined;
    }
    let live = true;
    setLoading(true);
    void api
      .previewLook(clipId, null)
      .then((result) => {
        if (!result.ok) throw new Error(result.reason);
        return decode(result.original);
      })
      .then((frame) => {
        if (live) setSource(frame);
      })
      .catch((cause: Error) => {
        if (!live) return;
        setSource(chart());
        setNotice({ text: `${cause.message} Grading on the test chart instead.`, problem: true });
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, clipId, onChart]);

  // The show LUT under the grade, read once per look.
  useEffect(() => {
    if (baseId === null || !api) {
      setBaseTable(null);
      return undefined;
    }
    const cached = tables.current.get(baseId);
    if (cached) {
      setBaseTable(cached);
      return undefined;
    }
    let live = true;
    void api.lookTable(baseId).then((result) => {
      if (!live) return;
      if (result.ok) {
        const table = { size: result.size, data: result.data };
        tables.current.set(baseId, table);
        setBaseTable(table);
      } else {
        setBaseTable(null);
        setNotice({ text: `${result.reason} The grade is shown on LOG.`, problem: true });
      }
    });
    return () => {
      live = false;
    };
  }, [api, baseId]);

  const reference = useMemo(() => (source ? (baseTable ? through(source, baseTable) : source.pixels) : null), [source, baseTable]);
  const graded = useMemo(() => (source ? through(source, gradeTable(shownCdl, baseTable)) : null), [source, baseTable, shownCdl]);

  // The viewer: graded left of the split, the show LUT alone (or LOG) right of it.
  useEffect(() => {
    const canvas = viewer.current;
    const context = context2d(canvas);
    if (!canvas || !context || !source || !graded || !reference) return;
    canvas.width = source.width;
    canvas.height = source.height;
    const image = context.createImageData(source.width, source.height);
    const edge = Math.round((split / 100) * source.width) * 4;
    const row = source.width * 4;
    for (let start = 0; start < image.data.length; start += row) {
      image.data.set(graded.subarray(start, start + edge), start);
      image.data.set(reference.subarray(start + edge, start + row), start + edge);
    }
    context.putImageData(image, 0, 0);
  }, [source, graded, reference, split]);

  // The scope, of the graded picture.
  useEffect(() => {
    const canvas = scopeCanvas.current;
    const context = context2d(canvas);
    if (!canvas || !context || !source || !graded) return;
    const image = scope(kind, graded, source.width);
    canvas.width = image.width;
    canvas.height = image.height;
    const out = context.createImageData(image.width, image.height);
    out.data.set(image.data);
    context.putImageData(out, 0, 0);
  }, [graded, kind, source]);

  const splitAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setSplit(Math.max(0, Math.min(100, Math.round(((event.clientX - box.left) / box.width) * 100))));
  };

  const startFrom = (id: string) => {
    const look = state.luts.find((lut) => String(lut.id) === id);
    if (!look?.sop) return;
    setCdl(limitCdl(look.sop));
    if (look.grade) {
      setBaseId(look.grade.baseLutId);
      setName(stem(look.name));
    } else setName(`${stem(look.name)}_graded`);
    setNotice(null);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!api || !name.trim()) return;
    setSaving(true);
    void api
      .saveGrade(name.trim(), cdl, baseId)
      .then((result: ProjectResult) => {
        if (result.ok) {
          dispatch({ type: 'projectState', project: result.state });
          setNotice({ text: `Saved to the library as ${stem(name.trim())}.cube. Assign it to a camera, scene or clip in Looks.`, problem: false });
        } else if (result.reason) setNotice({ text: result.reason, problem: true });
      })
      .finally(() => setSaving(false));
  };

  const existing = state.luts.find((lut) => lut.grade && stem(lut.name).toLowerCase() === stem(name.trim()).toLowerCase());
  const referenceTag = baseLut ? 'SHOW LUT · NO GRADE' : 'LOG · ORIGINAL';
  const clipLabel = onChart ? 'Test chart' : (state.previewClips.find((clip) => clip.id === clipId)?.label ?? clipId);

  return (
    <div className="screen out">
      <ScreenHeader
        step="output"
        eyebrow="06 · Output · Grade"
        title="Grade"
        description="A limited on-set grade: ASC CDL offset, power, slope and saturation over the show LUT, read against scopes. Camera originals are never baked."
        actions={
          <button type="button" className="btn tall" disabled={isIdentityCdl(cdl)} onClick={() => setCdl(IDENTITY_CDL)}>
            Reset grade
          </button>
        }
      />
      {notice ? (
        <p className="looks-notice" role={notice.problem ? 'alert' : 'status'} style={tone(statusVar(notice.problem ? 'problem' : 'done'))}>
          {notice.text}
          {!notice.problem ? (
            <>
              {' '}
              <button type="button" className="btn ghost small" onClick={() => dispatch({ type: 'go', screen: 'looks' })}>
                Open Looks
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      <div className="grade-layout">
        <div className="stack gap-20">
          <section className="card card-body stack">
            <div className="row grade-source">
              <h3 className="card-title grow">Viewer · {clipLabel}</h3>
              {api && state.previewClips.length > 0 && state.ffmpeg ? (
                <select className="select looks-clip" aria-label="Clip to grade" value={clipId || CHART} onChange={(event) => setPicked(event.target.value)}>
                  {state.previewClips.map((clip) => (
                    <option key={clip.id} value={clip.id}>
                      {clip.label}
                    </option>
                  ))}
                  <option value={CHART}>Test chart</option>
                </select>
              ) : null}
              <label className="row grade-base">
                <span className="muted small">Show LUT</span>
                <select
                  className="select"
                  aria-label="Show LUT under the grade"
                  value={baseId === null ? '' : String(baseId)}
                  onChange={(event) => setBaseId(event.target.value === '' ? null : Number(event.target.value))}
                  disabled={!api}
                >
                  <option value="">None · grade on LOG</option>
                  {bases.map((lut) => (
                    <option key={lut.id} value={String(lut.id)}>
                      {lut.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div
              ref={stage}
              className="look-stage grade-stage"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture?.(event.pointerId);
                splitAt(event);
              }}
              onPointerMove={(event) => {
                if (event.buttons === 1) splitAt(event);
              }}
            >
              <canvas ref={viewer} className="look-frame" aria-label={`${clipLabel}, graded left of the split`} />
              {split < 100 ? <div className="look-split" style={{ left: `${split}%` }} aria-hidden="true" /> : null}
              <span className="stage-tag left">GRADED</span>
              {split < 100 ? <span className="stage-tag right">{referenceTag}</span> : null}
              {loading ? <span className="stage-tag centre">Reading a frame…</span> : null}
            </div>
            <input
              type="range"
              className="split-range"
              min={0}
              max={100}
              value={split}
              aria-label={`Split between the grade and ${referenceTag.toLowerCase()}`}
              onChange={(event) => setSplit(Number(event.target.value))}
            />
          </section>

          <section className="card card-body stack">
            <div className="row">
              <h3 className="card-title grow">Scopes</h3>
              <div className="row grade-scope-tabs" role="tablist" aria-label="Scope">
                {SCOPES.map((item) => (
                  <button key={item.kind} type="button" role="tab" aria-selected={kind === item.kind} className={`btn small${kind === item.kind ? '' : ' ghost'}`} onClick={() => setKind(item.kind)}>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className={`grade-scope ${kind}`}>
              <canvas ref={scopeCanvas} aria-label={`${SCOPES.find((item) => item.kind === kind)?.label} of the graded picture`} />
              {kind === 'waveform' || kind === 'parade' ? (
                <div className="grade-scale" aria-hidden="true">
                  <span>100</span>
                  <span>75</span>
                  <span>50</span>
                  <span>25</span>
                  <span>0</span>
                </div>
              ) : null}
            </div>
            <p className="muted small grade-scope-note">
              {kind === 'vectorscope'
                ? 'Boxes mark 75 % colour bars; the line from the centre toward red and yellow is skin tone.'
                : kind === 'histogram'
                  ? 'Pixels at each level, black on the left, white on the right. A spike at either end is clipping.'
                  : '0 to 100 % of the picture\'s levels, left to right as in the frame.'}
            </p>
          </section>
        </div>

        <div className="stack gap-20">
          <section className="card card-body stack grade-controls" aria-label="Grade controls">
            {startingPoints.length ? (
              <label className="row grade-start">
                <span className="muted small grow">Start from</span>
                <select className="select" aria-label="Start from a look" value="" onChange={(event) => startFrom(event.target.value)}>
                  <option value="">A look in the library…</option>
                  {startingPoints.map((lut) => (
                    <option key={lut.id} value={String(lut.id)}>
                      {lut.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {WHEELS.map((wheel) => {
              const values = cdl[wheel.key];
              const limits = GRADE_LIMITS[wheel.key];
              return (
                <fieldset key={wheel.key} className="grade-wheel">
                  <legend className="row">
                    <span className="strong-500">{wheel.label}</span>
                    <span className="muted small grow">{wheel.also}</span>
                    <button
                      type="button"
                      className="btn ghost small"
                      disabled={values.every((value) => value === wheel.neutral)}
                      aria-label={`Reset ${wheel.label}`}
                      onClick={() => setCdl(limitCdl({ ...cdl, [wheel.key]: [wheel.neutral, wheel.neutral, wheel.neutral] }))}
                    >
                      Reset
                    </button>
                  </legend>
                  <p className="muted small grade-hint">{wheel.hint}</p>
                  <label className="grade-slider master">
                    <span>All</span>
                    <input
                      type="range"
                      min={limits.min}
                      max={limits.max}
                      step={wheel.step}
                      value={mean(values)}
                      aria-label={`${wheel.label}, all channels`}
                      onChange={(event) => setCdl(setMaster(cdl, wheel.key, Number(event.target.value)))}
                      onDoubleClick={() => setCdl(limitCdl({ ...cdl, [wheel.key]: [wheel.neutral, wheel.neutral, wheel.neutral] }))}
                    />
                    <output className="mono">{fixed(mean(values))}</output>
                  </label>
                  {CHANNELS.map((channel) => (
                    <label key={channel.short} className={`grade-slider ${channel.name.toLowerCase()}`}>
                      <span>{channel.short}</span>
                      <input
                        type="range"
                        min={limits.min}
                        max={limits.max}
                        step={wheel.step}
                        value={values[channel.index]}
                        aria-label={`${wheel.label}, ${channel.name.toLowerCase()}`}
                        onChange={(event) => setCdl(setChannel(cdl, wheel.key, channel.index, Number(event.target.value)))}
                        onDoubleClick={() => setCdl(setChannel(cdl, wheel.key, channel.index, wheel.neutral))}
                      />
                      <output className="mono">{fixed(values[channel.index])}</output>
                    </label>
                  ))}
                </fieldset>
              );
            })}
            <fieldset className="grade-wheel">
              <legend className="row">
                <span className="strong-500">Saturation</span>
                <span className="grow" />
                <button type="button" className="btn ghost small" disabled={cdl.sat === 1} aria-label="Reset Saturation" onClick={() => setCdl({ ...cdl, sat: 1 })}>
                  Reset
                </button>
              </legend>
              <label className="grade-slider master">
                <span>Sat</span>
                <input
                  type="range"
                  min={GRADE_LIMITS.sat.min}
                  max={GRADE_LIMITS.sat.max}
                  step={0.01}
                  value={cdl.sat}
                  aria-label="Saturation"
                  onChange={(event) => setCdl(limitCdl({ ...cdl, sat: Number(event.target.value) }))}
                  onDoubleClick={() => setCdl({ ...cdl, sat: 1 })}
                />
                <output className="mono">{fixed(cdl.sat)}</output>
              </label>
            </fieldset>
            <p className="mono muted small grade-sop" aria-label="The grade as an ASC CDL">
              SOP ({cdl.slope.map(fixed).join(' ')})({cdl.offset.map(fixed).join(' ')})({cdl.power.map(fixed).join(' ')}) · SAT {fixed(cdl.sat)}
            </p>
          </section>

          <section className="card card-body stack">
            <h3 className="card-title">Save to the library</h3>
            <p className="muted small grade-hint">
              {baseLut ? `Baked over ${baseLut.name} for the dailies` : 'Baked on LOG for the dailies'}; editorial gets the CDL numbers with each clip it is assigned to.
            </p>
            <form className="row grade-save" onSubmit={save}>
              <input className="input grow" aria-label="Grade name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
              <button type="submit" className="btn" disabled={!api || !name.trim() || saving}>
                {existing ? 'Update grade' : 'Save grade'}
              </button>
            </form>
            {!api ? <p className="muted small grade-hint">Open a production to keep grades. This preview grades the test chart.</p> : null}
          </section>
        </div>
      </div>
    </div>
  );
}
