// Ported from VC Film Studio (lib/timecode.ts @ 56e7a9c) so both read a sync box the same way. Keep the two in step.
// Changed from the original only by the non-null marks (!) that VC DIT's stricter indexing checks need.
/**
 * SMPTE timecode.
 *
 * The script supervisor's stopwatch produces a duration, and editorial needs
 * that duration as timecode against the same clock the cameras are running.
 * Getting this wrong is not a cosmetic problem: a log whose timecode does not
 * match the media is a log an editor stops opening.
 *
 * ---------------------------------------------------------------------------
 * TWO RATES, AND THEY ARE NOT THE SAME NUMBER
 *
 * At 23.976 and 29.97 the camera runs at a fraction of a whole number of
 * frames per second, but TIMECODE COUNTS AT THE WHOLE NUMBER. One hour of
 * 23.976 timecode is 3603.6 seconds of real time — the 0.1% that the whole
 * pulldown mess exists to paper over.
 *
 * So there are two rates everywhere here:
 *
 *   actual   23.976   what a second of wall clock is worth in frames
 *   nominal  24       what a second of TIMECODE is worth in frames
 *
 * A wall-clock duration converts to frames with the ACTUAL rate. Frames format
 * as timecode with the NOMINAL one. Using the same number for both is the
 * classic bug and it drifts by about three and a half seconds an hour, which
 * is a shot and a half.
 *
 * ---------------------------------------------------------------------------
 * DROP FRAME DROPS NUMBERS, NOT PICTURES
 *
 * At 29.97 and 59.94, drop-frame timecode skips two (or four) frame NUMBERS at
 * the top of every minute except every tenth, so the count keeps pace with the
 * wall clock. No picture is lost. It is written with semicolons, which is how
 * an editor tells at a glance which they are holding.
 *
 * Everything here is pure.
 */

export type RateKey =
  | '23.976' | '24' | '25' | '29.97df' | '29.97' | '30'
  | '48' | '50' | '59.94df' | '59.94' | '60';

export type Rate = {
  key: RateKey;
  label: string;
  /** Frames per real second. What a stopwatch measures against. */
  actual: number;
  /** Frames per timecode second. What the display counts in. */
  nominal: number;
  dropFrame: boolean;
};

export const RATES: Rate[] = [
  { key: '23.976', label: '23.976', actual: 24000 / 1001, nominal: 24, dropFrame: false },
  { key: '24',     label: '24',     actual: 24,           nominal: 24, dropFrame: false },
  { key: '25',     label: '25 (PAL)', actual: 25,         nominal: 25, dropFrame: false },
  { key: '29.97df', label: '29.97 DF', actual: 30000 / 1001, nominal: 30, dropFrame: true },
  { key: '29.97',  label: '29.97 NDF', actual: 30000 / 1001, nominal: 30, dropFrame: false },
  { key: '30',     label: '30',     actual: 30,           nominal: 30, dropFrame: false },
  { key: '48',     label: '48',     actual: 48,           nominal: 48, dropFrame: false },
  { key: '50',     label: '50',     actual: 50,           nominal: 50, dropFrame: false },
  { key: '59.94df', label: '59.94 DF', actual: 60000 / 1001, nominal: 60, dropFrame: true },
  { key: '59.94',  label: '59.94 NDF', actual: 60000 / 1001, nominal: 60, dropFrame: false },
  { key: '60',     label: '60',     actual: 60,           nominal: 60, dropFrame: false },
];

const BY_KEY = new Map(RATES.map((r) => [r.key, r]));

export function rateFor(key: string): Rate {
  return BY_KEY.get(key as RateKey) ?? RATES[0]!;
}

/**
 * The rate a project's frame_rate column means.
 *
 * 29.97 and 59.94 are ambiguous — both a drop and a non-drop timecode run at
 * that picture rate — and broadcast is overwhelmingly drop, so that is the
 * assumption. It is a stored setting the supervisor can change, not a guess
 * made once and hidden.
 */
export function rateFromProject(frameRate: number | string | null | undefined): Rate {
  const n = Number(frameRate);
  if (!Number.isFinite(n)) return RATES[0]!;
  if (near(n, 23.976)) return rateFor('23.976');
  if (near(n, 24)) return rateFor('24');
  if (near(n, 25)) return rateFor('25');
  if (near(n, 29.97)) return rateFor('29.97df');
  if (near(n, 30)) return rateFor('30');
  if (near(n, 48)) return rateFor('48');
  if (near(n, 50)) return rateFor('50');
  if (near(n, 59.94)) return rateFor('59.94df');
  if (near(n, 60)) return rateFor('60');
  return RATES[0]!;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.02;

/* ------------------------------------------------------------- formatting --- */

const pad = (n: number, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, '0');

/**
 * Frames to timecode.
 *
 * Drop-frame renumbering happens FIRST, then the result is formatted as though
 * it were a plain count at the nominal rate. That ordering is the whole trick;
 * doing it the other way round produces a value that is right at 00:00 and
 * drifts from there.
 */
export function framesToTimecode(frames: number, rate: Rate): string {
  if (!Number.isFinite(frames)) return blank(rate);
  const negative = frames < 0;
  let f = Math.abs(Math.round(frames));

  if (rate.dropFrame) f = applyDropFrame(f, rate.nominal);

  const fps = rate.nominal;
  const ff = f % fps;
  const totalSeconds = Math.floor(f / fps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  // Wraps at 24 hours, like every timecode display and every camera.
  const hh = Math.floor(totalSeconds / 3600) % 24;

  const sep = rate.dropFrame ? ';' : ':';
  return `${negative ? '-' : ''}${pad(hh)}:${pad(mm)}:${pad(ss)}${sep}${pad(ff)}`;
}

/**
 * The drop-frame renumbering.
 *
 * Two frame numbers are skipped at the top of every minute, except every tenth
 * minute. Written against the frame COUNT rather than by walking minutes,
 * because a walk is O(duration) and this runs on every render of a log with
 * three hundred rows.
 */
function applyDropFrame(frames: number, nominal: number): number {
  // 2 at 30, 4 at 60. Derived rather than hardcoded so 59.94 is not a special
  // case somebody forgets to add.
  const drop = Math.round(nominal / 15);
  const perMin = nominal * 60 - drop;                    // 1798 at 29.97
  /* A ten-minute block is NINE dropping minutes plus one that does not:
     9*1798 + 1800 = 17982. Not nominal*600, which is 18000 and counts frames
     that do not exist — the classic off-by-eighteen that reads correctly for
     the first ten minutes and drifts from there. */
  const per10Min = perMin * 9 + nominal * 60;            // 17982 at 29.97

  const d = Math.floor(frames / per10Min);
  const m = frames % per10Min;

  // The first `drop` frames of a ten-minute block are inside the minute that
  // is NOT dropped, so they take no extra offset.
  return m > drop
    ? frames + drop * 9 * d + drop * Math.floor((m - drop) / perMin)
    : frames + drop * 9 * d;
}

function blank(rate: Rate): string {
  const sep = rate.dropFrame ? ';' : ':';
  return `00:00:00${sep}00`;
}

/**
 * Timecode back to frames.
 *
 * Accepts either separator whatever the rate says, because a supervisor typing
 * a value off the side of a camera will use whichever the camera showed and
 * being pedantic about a semicolon helps nobody.
 */
export function timecodeToFrames(tc: string, rate: Rate): number | null {
  const m = tc.trim().match(/^(-)?(\d{1,2})[:;](\d{1,2})[:;](\d{1,2})[:;.](\d{1,3})$/);
  if (!m) return null;
  const [, neg, h, mi, s, f] = m;
  const hh = Number(h), mm = Number(mi), ss = Number(s), ff = Number(f);
  if (mm > 59 || ss > 59 || ff >= rate.nominal) return null;

  const fps = rate.nominal;
  let frames: number;

  if (rate.dropFrame) {
    const drop = Math.round(fps / 15);
    // The frames that do not exist: two per minute, except every tenth.
    const totalMinutes = hh * 60 + mm;
    const dropped = drop * (totalMinutes - Math.floor(totalMinutes / 10));
    frames = ((hh * 3600 + mm * 60 + ss) * fps + ff) - dropped;
  } else {
    frames = (hh * 3600 + mm * 60 + ss) * fps + ff;
  }

  return neg ? -frames : frames;
}

/* --------------------------------------------------------------- duration --- */

/**
 * A measured duration in milliseconds, as frames.
 *
 * The ACTUAL rate, because this came from a clock. A ten second take at 23.976
 * is 239.76 frames of picture, not 240 — and the difference compounds across a
 * day into a timecode that no longer lands on the media.
 */
export function msToFrames(ms: number, rate: Rate): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.round((ms / 1000) * rate.actual);
}

export function framesToMs(frames: number, rate: Rate): number {
  if (!Number.isFinite(frames)) return 0;
  return (frames / rate.actual) * 1000;
}

/** A duration as timecode. Always non-drop: a LENGTH has no wall clock to keep
    pace with, and semicolons on a duration read as an absolute time. */
export function durationTimecode(ms: number, rate: Rate): string {
  const plain: Rate = { ...rate, dropFrame: false };
  return framesToTimecode(msToFrames(ms, rate), plain);
}

/**
 * A duration as a stopwatch reads it: m:ss.t
 *
 * What the supervisor watches while the camera runs. Tenths, not frames — a
 * frame counter flickering twenty-four times a second is unreadable and
 * nobody is timing a take to the frame by eye.
 */
export function stopwatchText(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const total = Math.floor(safe / 100);          // tenths
  const tenths = total % 10;
  const seconds = Math.floor(total / 10);
  const ss = seconds % 60;
  const mm = Math.floor(seconds / 60);
  return `${mm}:${pad(ss)}.${tenths}`;
}

/** Minutes and seconds, for a printed log where tenths are noise. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/* ------------------------------------------------------------- the clock --- */

/**
 * A jam-sync point: what the timecode read at a known instant.
 *
 * This is how a sync box is actually used. You jam the box (or read its
 * display), record the timecode against the device's own clock at that moment,
 * and from then on the timecode is derived by adding elapsed real time. It is
 * exactly what a Lockit or a Tentacle does internally, and it does not need
 * the browser to speak to the hardware.
 */
export type JamPoint = {
  /** Timecode at the instant of the jam. */
  timecode: string;
  /** Device clock at that instant, epoch ms. */
  atEpochMs: number;
  rateKey: RateKey;
  /**
   * HOW FAST THE BOX'S TIMECODE ACTUALLY MOVES, in frames per real
   * millisecond, measured from the box itself. Optional.
   *
   * There is a genuine ambiguity at 23.976 and this exists because guessing
   * which side of it a box sits on was wrong. LTC at 23.976 carries 24000/1001
   * frames per real second, so a counter that rolls over every 24 frames takes
   * 1.001 real seconds per timecode second and falls behind the wall clock by
   * 3.6 seconds an hour. Plenty of boxes do exactly that. Others keep the
   * timecode VALUE locked to the wall clock and let the frame rate be the slow
   * part. Both are in the field and nothing in the signal says which you have.
   *
   * Measured on a real UltraSync ONE: over 4214 seconds of free run the
   * application fell 4 seconds and 6 frames behind the box. That is 1000/1001
   * to three figures - the box's timecode advances 1:1 with real time and this
   * code was applying the pull-down anyway. Over a fourteen-hour day that is
   * fifty seconds, which is not a rounding error on a log that has to match
   * the media.
   *
   * So it is no longer assumed. While the cable is connected the reader watches
   * the box and works out the ratio, and the free run continues at the rate the
   * box was actually keeping. When nothing has been measured this is undefined
   * and rate.actual is used, which is the old behaviour and the better guess of
   * the two.
   */
  framesPerMs?: number;
};

/**
 * Timecode now, free-running from a jam point.
 *
 * Elapsed wall clock converts to frames at the rate the BOX was measured to be
 * keeping, when there is one, and at the nominal actual rate when there is not.
 * See JamPoint.framesPerMs for why that is not the same thing and why guessing
 * cost four seconds in seventy minutes.
 */
export function timecodeAt(jam: JamPoint, nowEpochMs: number): string | null {
  const rate = rateFor(jam.rateKey);
  const base = timecodeToFrames(jam.timecode, rate);
  if (base === null) return null;
  const perMs = usableFramesPerMs(jam.framesPerMs, rate) ?? rate.actual / 1000;
  const elapsed = Math.round((nowEpochMs - jam.atEpochMs) * perMs);
  const total = base + elapsed;
  // Before the jam is not an error — a supervisor can jam mid-take — but it
  // must not produce a negative display.
  return framesToTimecode(Math.max(0, total), rate);
}

/**
 * How far a free-running clock has drifted from a fresh reading.
 *
 * A sync box is re-jammed through the day because crystals drift; showing the
 * supervisor how far out they are is what tells them when. Returned in frames,
 * signed: positive means the free run is AHEAD of the box.
 */
export function driftFrames(jam: JamPoint, observedTimecode: string, atEpochMs: number): number | null {
  const rate = rateFor(jam.rateKey);
  const observed = timecodeToFrames(observedTimecode, rate);
  const predicted = timecodeAt(jam, atEpochMs);
  if (observed === null || predicted === null) return null;
  const p = timecodeToFrames(predicted, rate);
  if (p === null) return null;
  return p - observed;
}

/** Is a jam still worth trusting? Half a frame per minute is roughly what a
    decent crystal does; ten frames out is a re-jam, not a rounding error. */
export function needsRejam(drift: number | null): boolean {
  return drift !== null && Math.abs(drift) >= 10;
}

/* ------------------------------------------------- measuring the box --- */

/**
 * A measured rate, only if it is worth believing.
 *
 * A CLOCK IS THE WRONG PLACE TO TRUST AN OUTLIER. A measurement taken across a
 * dropped frame, a decoder glitch or the box being re-jammed mid-window can
 * come out at any value at all, and a free run running at twice speed is worse
 * than one running 0.1% slow: the slow one looks plausible for an hour, the
 * fast one is wrong immediately but so is the take log written from it.
 *
 * The real answer is always within a whisker of the nominal rate - the whole
 * question is 1000/1001, a tenth of a percent. So anything further out than 1%
 * is not a slow crystal, it is a bad measurement, and it is discarded rather
 * than smoothed.
 */
export function usableFramesPerMs(
  measured: number | undefined | null, rate: Rate,
): number | null {
  if (measured === undefined || measured === null) return null;
  if (!Number.isFinite(measured) || measured <= 0) return null;
  const nominal = rate.actual / 1000;
  const ratio = measured / nominal;
  if (ratio < 0.99 || ratio > 1.01) return null;
  return measured;
}

/**
 * The box's own rate, from two readings of it.
 *
 * Both readings must be real decodes off the cable, with the device clock
 * recorded at each. The window has to be long enough that the answer means
 * something: the two candidate conventions are a tenth of a percent apart, and
 * a reading is only good to about a frame, so a sixty-second window can barely
 * tell them apart and a ten-second one cannot tell them apart at all.
 *
 * Returns null rather than a bad number. Null is handled - it means the free
 * run uses the nominal rate, which is where this started.
 */
export const MIN_MEASURE_MS = 120_000;

export function measureFramesPerMs(
  first: { frames: number; atEpochMs: number },
  last: { frames: number; atEpochMs: number },
  rate: Rate,
): number | null {
  const ms = last.atEpochMs - first.atEpochMs;
  if (!Number.isFinite(ms) || ms < MIN_MEASURE_MS) return null;
  const frames = last.frames - first.frames;
  if (!Number.isFinite(frames) || frames <= 0) return null;
  return usableFramesPerMs(frames / ms, rate);
}

/**
 * What the measurement means, in words a supervisor can act on.
 *
 * Seconds per hour, because "0.0999%" is not a thing anybody can check against
 * a box, and drifting away from the cameras by four seconds an hour is.
 */
export function measuredDriftSaysPerHour(
  measured: number | undefined | null, rate: Rate,
): number | null {
  const usable = usableFramesPerMs(measured, rate);
  if (usable === null) return null;
  const nominalPerMs = rate.actual / 1000;
  // How many timecode seconds the box gains on the nominal assumption per hour.
  return ((usable - nominalPerMs) * 3_600_000) / rate.nominal;
}

/**
 * How long ago, for somebody to judge a free run by.
 *
 * "Derived from the last reading 21175s ago" is a real thing this screen said.
 * Nobody converts that in their head, so nobody read it, so the one number
 * that says whether to trust the display was decoration.
 *
 * Coarse on purpose as it gets older: at six hours the minutes do not matter
 * and the hours are the whole story. Under a minute it stays in seconds,
 * because that is the range where a supervisor is deciding whether the cable
 * just came out.
 */
export function agoText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time ago';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * Whether a free run has been going so long it should not be read as a number.
 *
 * A jam is a real instant and the arithmetic stays honest forever, but the BOX
 * does not: overnight it is switched off, re-jammed, or its battery goes. A
 * clock derived from yesterday morning is not a slightly worse number, it is a
 * different number entirely.
 *
 * Twelve hours rather than a shift length: a supervisor coming back to a cart
 * after lunch is still on the same jam and the same box, and telling them to
 * re-jam over a two-hour break would be the sort of warning people learn to
 * ignore.
 */
export const STALE_FREE_RUN_MS = 12 * 60 * 60 * 1000;

export function freeRunIsStale(ms: number): boolean {
  return Number.isFinite(ms) && ms >= STALE_FREE_RUN_MS;
}
