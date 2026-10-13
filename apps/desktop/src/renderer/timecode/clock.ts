import { useSyncExternalStore } from 'react';
import { frameToTimecode } from './ltc';
import { blockSamplesFor, crossings, freshCrossings, freshReader, LTC_AUDIO_CONSTRAINTS, readBlock, readerHealth, type CrossingState, type ReaderHealth, type ReaderState } from './ltc-reader';
import { samplesPerBit } from './ltc';
import { framesToTimecode, measureFramesPerMs, rateFor, rateFromProject, timecodeAt, timecodeToFrames, type JamPoint, type RateKey } from './timecode';

/**
 * The DIT station's timecode: what a note is stamped with (the same way the
 * script supervisor's are in VC Film Studio, with the same reader).
 *
 * - **Sync box (LTC):** a cable from the Lockit / Tentacle / UltraSync into an
 *   audio input. Read every frame while it is in; if it comes out the clock
 *   free-runs from the last reading at the rate the box was measured to keep,
 *   and says so. It never shows a dead number as live.
 * - **Jam by hand:** read the box, type what it says, press Jam; free-runs.
 * - **Computer clock:** time of day at the production's rate. Rough, and
 *   labelled as rough; right only if the cameras run time of day too.
 *
 * One store for the window, outside React, so the reader can run while any
 * screen is open; components read it with useTimecode().
 */

export type TcSource = 'ltc' | 'jam' | 'clock';

export interface ClockState {
  source: TcSource;
  rateKey: RateKey;
  /** The chosen audio input, by device id ("" for the default). */
  deviceId: string;
  devices: { deviceId: string; label: string }[];
  listening: boolean;
  health: ReaderHealth | null;
  /** The last jam: from the cable, or by hand. */
  jam: JamPoint | null;
  /** How loud the input is, 0–1, for finding the right one. */
  level: number;
  error: string | null;
}

/** What a note is stamped with. */
export interface Stamp {
  tc: string | null;
  /** Where it came from: read live off the cable, free-running from a reading or a jam, or the computer's clock. */
  source: 'ltc' | 'free-run' | 'jam' | 'clock';
  rate: RateKey;
}

const STORE_KEY = 'vcdit.timecode';

/** "23.976 fps" → the rate the timecode counts in. 29.97 and 59.94 are taken as drop-frame unless marked NDF, as in VC Film Studio. */
export const rateOfProduction = (frameRate: string): RateKey => {
  const key = rateFromProject(Number.parseFloat(frameRate)).key;
  if (/\bndf\b|non.?drop/i.test(frameRate) && key.endsWith('df')) return key.slice(0, -2) as RateKey;
  return key;
};

const load = (): Partial<ClockState> => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Partial<ClockState>;
    return { source: saved.source, deviceId: saved.deviceId, jam: saved.jam ?? null };
  } catch {
    return {};
  }
};

let state: ClockState = {
  source: 'clock',
  rateKey: '23.976',
  deviceId: '',
  devices: [],
  listening: false,
  health: null,
  jam: null,
  level: 0,
  error: null,
  ...Object.fromEntries(Object.entries(load()).filter(([, value]) => value !== undefined)),
};
const listeners = new Set<() => void>();
const set = (patch: Partial<ClockState>) => {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ source: state.source, deviceId: state.deviceId, jam: state.jam }));
  } catch {
    // Not kept between sessions; it still works now.
  }
  for (const listener of listeners) listener();
};

export const clock = {
  get: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setRate: (rateKey: RateKey) => state.rateKey !== rateKey && set({ rateKey }),
  setSource: (source: TcSource) => {
    if (source !== 'ltc') stopListening();
    set({ source, error: null });
  },
  setDevice: (deviceId: string) => set({ deviceId }),
  /** Jam by hand: the timecode the box shows, at this instant. */
  jam: (timecode: string): string | null => {
    const rate = rateFor(state.rateKey);
    if (timecodeToFrames(timecode.trim(), rate) === null) return 'That is not a timecode at this rate, e.g. 14:05:40:12.';
    set({ jam: { timecode: timecode.trim(), atEpochMs: Date.now(), rateKey: state.rateKey }, source: 'jam', error: null });
    return null;
  },
  listDevices: () => void listDevices(),
  start: () => startListening(),
  stop: () => stopListening(),
};

/** The timecode now, and how far it can be trusted. */
export const stampAt = (now: number, current: ClockState = state): Stamp => {
  const rate = rateFor(current.rateKey);
  if (current.source === 'clock') {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return { tc: framesToTimecode(Math.floor(((now - midnight.getTime()) / 1000) * rate.actual), rate), source: 'clock', rate: rate.key };
  }
  if (!current.jam) return { tc: null, source: current.source === 'ltc' ? 'free-run' : 'jam', rate: rate.key };
  const tc = timecodeAt(current.jam, now);
  if (current.source === 'jam') return { tc, source: 'jam', rate: current.jam.rateKey };
  return { tc, source: current.health?.state === 'locked' ? 'ltc' : 'free-run', rate: current.jam.rateKey };
};

export const useTimecode = (): ClockState => useSyncExternalStore(clock.subscribe, clock.get, clock.get);

// ------------------------------------------------ reading the cable

let audio: { context: AudioContext; stream: MediaStream } | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;

async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
  set({
    devices: all
      .filter((device) => device.kind === 'audioinput' && device.deviceId)
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Input ${index + 1}` })),
  });
}

function stopListening() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  audio?.stream.getTracks().forEach((track) => track.stop());
  void audio?.context.close().catch(() => undefined);
  audio = null;
  if (state.listening) set({ listening: false });
}

async function startListening(): Promise<void> {
  stopListening();
  set({ error: null, source: 'ltc' });
  try {
    if (window.vcdit?.microphone && !(await window.vcdit.microphone())) {
      throw new Error('NotAllowedError: macOS has not given VC DIT the audio input. Allow it in System Settings → Privacy & Security → Microphone.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...LTC_AUDIO_CONSTRAINTS, ...(state.deviceId ? { deviceId: { exact: state.deviceId } } : {}) },
    });
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        set({ error: 'The audio input disappeared: the adapter was unplugged, or its driver reset. Plug it back in and press Listen again.' });
        stopListening();
      });
    }
    await listDevices();
    const context = new AudioContext();
    if (context.state === 'suspended') await context.resume();
    audio = { context, stream };
    await context.audioWorklet.addModule(new URL('ltc-worklet.js', document.baseURI).href);
    const rate = rateFor(state.rateKey);
    const spb = samplesPerBit(context.sampleRate, rate.actual);
    const node = new AudioWorkletNode(context, 'ltc-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { blockSamples: blockSamplesFor(context.sampleRate, rate.actual) },
    });
    let cross: CrossingState = freshCrossings();
    let reader: ReaderState = freshReader();
    let first: { frames: number; atEpochMs: number } | null = null;
    let measured: number | undefined;
    let lastLevel = 0;
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const at = Date.now();
      const c = crossings(new Float32Array(event.data), cross);
      cross = c.state;
      const before = reader.framesRead;
      reader = readBlock(reader, c.intervals, spb, c.state.peak, at);
      const patch: Partial<ClockState> = { health: readerHealth(reader, at) };
      if (at - lastLevel > 200) {
        lastLevel = at;
        patch.level = c.state.peak;
      }
      if (reader.framesRead > before && reader.last) {
        // The box's own drop-frame flag decides how 29.97 / 59.94 count.
        const rateKey = (reader.last.frame.dropFrame && !state.rateKey.endsWith('df') ? `${state.rateKey}df` : state.rateKey) as RateKey;
        const tc = frameToTimecode(reader.last.frame);
        const frames = timecodeToFrames(tc, rateFor(rateKey));
        // Measure how fast the box really runs while the cable is in, so a free run afterwards keeps its pace.
        if (frames !== null) {
          if (!first) first = { frames, atEpochMs: reader.last.atEpochMs };
          else measured = measureFramesPerMs(first, { frames, atEpochMs: reader.last.atEpochMs }, rateFor(rateKey)) ?? measured;
        }
        patch.jam = { timecode: tc, atEpochMs: reader.last.atEpochMs, rateKey, ...(measured ? { framesPerMs: measured } : {}) };
      }
      set(patch);
    };
    context.createMediaStreamSource(stream).connect(node);
    // The state moves on even when no audio arrives: LOCKED becomes LOST.
    healthTimer = setInterval(() => set({ health: readerHealth(reader, Date.now()) }), 250);
    set({ listening: true });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    stopListening();
    set({
      error: /NotAllowedError|Permission/i.test(message)
        ? message.replace(/^NotAllowedError:\s*/, '') || 'The audio input was refused.'
        : /NotFoundError|Overconstrained/i.test(message)
          ? 'That audio input is not connected. Plug the adapter in and choose it again.'
          : message,
    });
  }
}
