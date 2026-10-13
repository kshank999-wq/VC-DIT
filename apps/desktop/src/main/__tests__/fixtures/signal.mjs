/**
 * The test sound: bursts of noise of varied length and loudness with gaps
 * between, from a fixed seed, so the production-sound WAV built in the tests
 * and the camera scratch audio in the fixture files (made from it with
 * make-sync-fixtures.mjs) are the same signal.
 */
export const RATE = 48000;

export const burstSignal = (seconds, seed = 7) => {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const out = new Float32Array(Math.round(seconds * RATE));
  let i = 0;
  while (i < out.length) {
    const gap = Math.round((0.05 + random() * 0.25) * RATE);
    const burst = Math.round((0.03 + random() * 0.2) * RATE);
    const level = 0.15 + random() * 0.6;
    i += gap;
    for (let j = 0; j < burst && i < out.length; j += 1, i += 1) out[i] = (random() * 2 - 1) * level;
  }
  return out;
};

/** A 16-bit PCM WAV, with a bext chunk (time reference) and an iXML chunk when given. */
export const wavBytes = (samples, { timeReference = null, ixml = null, channels = 1 } = {}) => {
  const chunks = [];
  const chunk = (id, body) => {
    const header = Buffer.alloc(8);
    header.write(id, 0, 'ascii');
    header.writeUInt32LE(body.length, 4);
    chunks.push(header, body);
    if (body.length % 2) chunks.push(Buffer.alloc(1));
  };
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(RATE, 4);
  fmt.writeUInt32LE(RATE * 2 * channels, 8);
  fmt.writeUInt16LE(2 * channels, 12);
  fmt.writeUInt16LE(16, 14);
  chunk('fmt ', fmt);
  if (timeReference !== null) {
    const bext = Buffer.alloc(602);
    bext.write('VC DIT test', 0, 'ascii');
    bext.writeBigUInt64LE(BigInt(timeReference), 338);
    chunk('bext', bext);
  }
  if (ixml) chunk('iXML', Buffer.from(ixml, 'utf8'));
  const data = Buffer.alloc(samples.length * 2 * channels);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    for (let c = 0; c < channels; c += 1) data.writeInt16LE(c === 0 ? value : Math.round(value / 2), (i * channels + c) * 2);
  }
  chunk('data', data);
  const body = Buffer.concat(chunks);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, body]);
};

/**
 * SMPTE linear timecode as sound, as a sync box feeds a camera's microphone
 * input: biphase mark, 80 bits a frame, starting `phase` of a frame before
 * the first sample (so the first sample is part-way into a frame).
 */
export const ltcSignal = ({ h, m, s, f }, fps, seconds, { dropFrame = false, phase = 0, amplitude = 0.5, rate = RATE } = {}) => {
  const base = Math.round(fps);
  const out = new Float32Array(Math.round(seconds * rate));
  const bitSamples = rate / (fps * 80);
  let level = amplitude;
  let frame = { h, m, s, f };
  const next = ({ h, m, s, f }) => {
    f += 1;
    if (f >= base) [f, s] = [0, s + 1];
    if (s >= 60) [s, m] = [0, m + 1];
    if (m >= 60) [m, h] = [0, h + 1];
    // Drop-frame: labels 00 and 01 are skipped at the start of each minute but every tenth.
    if (dropFrame && s === 0 && f < 2 && m % 10 !== 0) f = 2;
    return { h: h % 24, m, s, f };
  };
  const bitsOf = ({ h, m, s, f }) => {
    const bits = new Array(80).fill(0);
    const put = (value, at, count) => {
      for (let i = 0; i < count; i += 1) bits[at + i] = (value >> i) & 1;
    };
    put(f % 10, 0, 4);
    put(Math.floor(f / 10), 8, 2);
    bits[10] = dropFrame ? 1 : 0;
    put(s % 10, 16, 4);
    put(Math.floor(s / 10), 24, 3);
    put(m % 10, 32, 4);
    put(Math.floor(m / 10), 40, 3);
    put(h % 10, 48, 4);
    put(Math.floor(h / 10), 56, 2);
    [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1].forEach((bit, i) => (bits[64 + i] = bit));
    return bits;
  };
  // Time in bits from the start of the first (partial) frame.
  let at = -phase * 80 * bitSamples;
  for (let k = 0; at < out.length; k += 1) {
    const bits = bitsOf(frame);
    for (const bit of bits) {
      level = -level;
      const half = at + bitSamples / 2;
      const end = at + bitSamples;
      for (let i = Math.max(0, Math.ceil(at)); i < Math.min(out.length, Math.ceil(end)); i += 1) {
        out[i] = bit && i >= half ? -level : level;
      }
      if (bit) {
        // The mid-bit flip: the level after the bit is the flipped one.
        level = -level;
      }
      at = end;
    }
    frame = next(frame);
  }
  return out;
};

/** A 16-bit PCM WAV with two channels, left and right. */
export const stereoWavBytes = (left, right) => {
  const frames = Math.min(left.length, right.length);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767))), i * 4);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767))), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};
