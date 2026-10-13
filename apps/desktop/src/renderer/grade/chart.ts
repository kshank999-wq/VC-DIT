/**
 * A test chart to grade on when there is no clip to read: 75 % colour bars,
 * a grey ramp from black to white, and patches of the colours a grade is
 * judged by (skin, sky, foliage, and black, mid grey and white). Each lands
 * where it should on the scopes, so they can be read before the first card.
 */

export const CHART_PATCHES: [number, number, number][] = [
  [0.76, 0.57, 0.47], // skin
  [0.36, 0.52, 0.74], // sky
  [0.3, 0.42, 0.2], // foliage
  [0.02, 0.02, 0.02],
  [0.18, 0.18, 0.18],
  [0.9, 0.9, 0.9],
];

const BARS: [number, number, number][] = [
  [0.75, 0.75, 0.75],
  [0.75, 0.75, 0],
  [0, 0.75, 0.75],
  [0, 0.75, 0],
  [0.75, 0, 0.75],
  [0.75, 0, 0],
  [0, 0, 0.75],
];

/** The chart's RGBA pixels. */
export const testChart = (width = 960, height = 402): Uint8ClampedArray => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const barsEnd = Math.round(height * 0.5);
  const rampEnd = Math.round(height * 0.72);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      let rgb: readonly [number, number, number];
      if (y < barsEnd) rgb = BARS[Math.min(BARS.length - 1, Math.floor((x / width) * BARS.length))]!;
      else if (y < rampEnd) {
        const level = x / (width - 1);
        rgb = [level, level, level];
      } else rgb = CHART_PATCHES[Math.min(CHART_PATCHES.length - 1, Math.floor((x / width) * CHART_PATCHES.length))]!;
      const at = (y * width + x) * 4;
      pixels[at] = rgb[0] * 255;
      pixels[at + 1] = rgb[1] * 255;
      pixels[at + 2] = rgb[2] * 255;
      pixels[at + 3] = 255;
    }
  return pixels;
};
