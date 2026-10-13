// Ported from VC Film Studio (public/ltc-worklet.js @ 56e7a9c).
/**
 * The audio tap.
 *
 * Runs on the browser's audio thread, which cannot import from the
 * application bundle — so this file is deliberately almost empty. It gathers
 * samples and hands them over; every decision about what they mean lives in
 * lib/ltc-reader.ts and lib/ltc.ts, where it can be tested.
 *
 * That split is on purpose. Duplicating the decoding here to save a few
 * kilobytes of message traffic would put the same logic in two places with
 * nothing forcing them to agree, which is a bug this codebase has already
 * paid for once.
 *
 * ---------------------------------------------------------------------------
 * WHY IT BUFFERS RATHER THAN POSTING EVERY BLOCK
 *
 * The audio thread delivers 128 samples at a time — under 3 milliseconds, a
 * fraction of one LTC bit. A window of audio is unusable at both ends, so a
 * block holding less than about three frames yields nothing at all. Posting
 * every 128 samples would decode exactly zero timecode while looking, from
 * every log and meter, like it was working perfectly.
 *
 * The size comes from blockSamplesFor() on the main thread and arrives in
 * processorOptions. It is not guessed here.
 */
class LtcTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const wanted = options?.processorOptions?.blockSamples;
    this.size = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : 8192;
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input connected yet. Staying alive matters: returning false would
    // retire the processor permanently and the cable could never be plugged
    // in afterwards.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      this.buf[this.n] = channel[i];
      this.n += 1;
      if (this.n === this.size) {
        // Transferred, not copied — the buffer is detached by the post, so a
        // fresh one is allocated rather than reused.
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('ltc-tap', LtcTap);
