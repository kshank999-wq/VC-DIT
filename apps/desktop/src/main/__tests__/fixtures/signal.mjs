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
