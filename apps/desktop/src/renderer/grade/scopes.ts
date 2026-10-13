/**
 * Video scopes for the Grade screen, from the graded frame's 8-bit pixels:
 *
 * - Waveform: each column of the picture, its Rec. 709 luma from 0 % at the
 *   bottom to 100 % at the top, brighter where more pixels sit.
 * - RGB parade: the same for red, green and blue side by side.
 * - Vectorscope: each pixel's colour difference (Cb across, Cr up), its
 *   distance from the centre its saturation; boxes mark 75 % colour bars,
 *   the diagonal the skin-tone line.
 * - Histogram: how many pixels at each level, per channel.
 *
 * Each returns an RGBA image, its graticule drawn in, ready to put on a canvas.
 */

export type ScopeKind = 'waveform' | 'parade' | 'vectorscope' | 'histogram';

export interface ScopeImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** At most this many pixels are read: plenty for a scope, quick enough to follow a slider. */
const SAMPLES = 200_000;

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Where an RGB colour (0–1) sits on the vectorscope, as a fraction of its square (0–1 across, 0–1 down). */
export const vectorPoint = (r: number, g: number, b: number): [number, number] => {
  const y = luma(r, g, b);
  const cb = (b - y) / 1.8556;
  const cr = (r - y) / 1.5748;
  return [0.5 + cb, 0.5 - cr];
};

/** The 75 % colour bars, where each lands. */
export const VECTOR_TARGETS: { name: string; rgb: [number, number, number] }[] = [
  { name: 'R', rgb: [0.75, 0, 0] },
  { name: 'Mg', rgb: [0.75, 0, 0.75] },
  { name: 'B', rgb: [0, 0, 0.75] },
  { name: 'Cy', rgb: [0, 0.75, 0.75] },
  { name: 'G', rgb: [0, 0.75, 0] },
  { name: 'Yl', rgb: [0.75, 0.75, 0] },
];

/** The skin-tone line's angle, counter-clockwise from Cb: 123°, between red and yellow. */
export const SKIN_ANGLE = (123 * Math.PI) / 180;

const blank = (width: number, height: number): ScopeImage => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
};

/** Light a pixel of the image, adding to what is there. */
const add = (image: ScopeImage, x: number, y: number, rgb: readonly [number, number, number], amount: number) => {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const at = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  image.data[at] = image.data[at]! + rgb[0] * amount;
  image.data[at + 1] = image.data[at + 1]! + rgb[1] * amount;
  image.data[at + 2] = image.data[at + 2]! + rgb[2] * amount;
};

const bump = (counts: Uint32Array, at: number) => {
  counts[at] = counts[at]! + 1;
};

/** A lit cell, with a little light on its neighbours: a flat colour is a point too small to see otherwise. */
const glowAt = (image: ScopeImage, x: number, y: number, rgb: readonly [number, number, number], level: number) => {
  add(image, x, y, rgb, level);
  add(image, x - 1, y, rgb, level * 0.35);
  add(image, x + 1, y, rgb, level * 0.35);
  add(image, x, y - 1, rgb, level * 0.35);
  add(image, x, y + 1, rgb, level * 0.35);
};

const GRATICULE: [number, number, number] = [70, 76, 84];

const hLine = (image: ScopeImage, y: number, from = 0, to = image.width) => {
  for (let x = from; x < to; x += 1) add(image, x, y, GRATICULE, 1);
};

/** The pixels to read: every `step`th, so no more than SAMPLES. */
const stride = (pixels: Uint8ClampedArray) => Math.max(1, Math.ceil(pixels.length / 4 / SAMPLES));

/** Counts to brightness: one pixel in a cell shows, a crowd saturates, smoothly between. */
const glow = (counts: Uint32Array, samples: number, cells: number) => {
  const gain = Math.max(0.02, (cells / Math.max(1, samples)) * 1.5);
  return (count: number) => (count === 0 ? 0 : 1 - Math.exp(-count * gain));
};

const traces = (pixels: Uint8ClampedArray, width: number, image: ScopeImage, channels: { pick: (r: number, g: number, b: number) => number; colour: [number, number, number]; from: number; to: number }[]) => {
  const rows = image.height;
  const counts = channels.map(() => new Uint32Array(image.width * rows));
  let samples = 0;
  // Whole rows, skipping rows rather than pixels, so every column of the picture is in its trace.
  const height = Math.floor(pixels.length / 4 / width);
  const rowStep = Math.max(1, Math.ceil((width * height) / SAMPLES));
  for (let p = 0; p < width * height; p += 1) {
    const x = p % width;
    if (Math.floor(p / width) % rowStep !== 0) {
      p += width - 1 - x;
      continue;
    }
    const at = p * 4;
    const r = pixels[at]! / 255;
    const g = pixels[at + 1]! / 255;
    const b = pixels[at + 2]! / 255;
    samples += 1;
    channels.forEach((channel, i) => {
      const column = channel.from + Math.min(channel.to - channel.from - 1, Math.floor((x / width) * (channel.to - channel.from)));
      const row = rows - 1 - Math.round(Math.min(1, Math.max(0, channel.pick(r, g, b))) * (rows - 1));
      bump(counts[i]!, row * image.width + column);
    });
  }
  channels.forEach((channel, i) => {
    const bright = glow(counts[i]!, samples, (channel.to - channel.from) * rows);
    for (let cell = 0; cell < counts[i]!.length; cell += 1) {
      const level = bright(counts[i]![cell]!);
      if (level > 0) glowAt(image, cell % image.width, Math.floor(cell / image.width), channel.colour, level);
    }
  });
};

/** The levels marked on a waveform: 0, 25, 50, 75 and 100 %. */
const levels = (image: ScopeImage) => {
  for (const level of [0, 0.25, 0.5, 0.75, 1]) hLine(image, Math.round((1 - level) * (image.height - 1)));
};

export const waveform = (pixels: Uint8ClampedArray, width: number, out = { width: 512, height: 256 }): ScopeImage => {
  const image = blank(out.width, out.height);
  levels(image);
  traces(pixels, width, image, [{ pick: luma, colour: [170, 235, 190], from: 0, to: out.width }]);
  return image;
};

export const parade = (pixels: Uint8ClampedArray, width: number, out = { width: 512, height: 256 }): ScopeImage => {
  const image = blank(out.width, out.height);
  levels(image);
  const third = Math.floor(out.width / 3);
  const gap = 4;
  traces(pixels, width, image, [
    { pick: (r) => r, colour: [255, 80, 80], from: 0, to: third - gap },
    { pick: (_r, g) => g, colour: [80, 230, 110], from: third + gap / 2, to: 2 * third - gap / 2 },
    { pick: (_r, _g, b) => b, colour: [90, 140, 255], from: 2 * third + gap, to: out.width },
  ]);
  return image;
};

export const vectorscope = (pixels: Uint8ClampedArray, size = 256): ScopeImage => {
  const image = blank(size, size);
  const centre = (size - 1) / 2;
  // Graticule: the edge of the colour gamut's circle, the axes, the skin-tone line, the 75 % bar targets.
  for (let a = 0; a < 720; a += 1) {
    const angle = (a / 720) * 2 * Math.PI;
    add(image, centre + Math.cos(angle) * centre, centre - Math.sin(angle) * centre, GRATICULE, 1);
  }
  for (let i = 0; i < size; i += 2) {
    add(image, i, centre, GRATICULE, 0.6);
    add(image, centre, i, GRATICULE, 0.6);
  }
  for (let d = 0; d < centre; d += 1) add(image, centre + Math.cos(SKIN_ANGLE) * d, centre - Math.sin(SKIN_ANGLE) * d, [150, 120, 90], 1);
  for (const target of VECTOR_TARGETS) {
    const [u, v] = vectorPoint(...target.rgb);
    const x = Math.round(u * (size - 1));
    const y = Math.round(v * (size - 1));
    for (let k = -4; k <= 4; k += 1) {
      add(image, x + k, y - 4, GRATICULE, 1.4);
      add(image, x + k, y + 4, GRATICULE, 1.4);
      add(image, x - 4, y + k, GRATICULE, 1.4);
      add(image, x + 4, y + k, GRATICULE, 1.4);
    }
  }
  const step = stride(pixels);
  const counts = new Uint32Array(size * size);
  let samples = 0;
  for (let p = 0; p < pixels.length / 4; p += step) {
    const at = p * 4;
    const [u, v] = vectorPoint(pixels[at]! / 255, pixels[at + 1]! / 255, pixels[at + 2]! / 255);
    bump(counts, Math.round(v * (size - 1)) * size + Math.round(u * (size - 1)));
    samples += 1;
  }
  const bright = glow(counts, samples, size * size * 0.15);
  for (let cell = 0; cell < counts.length; cell += 1) {
    const level = bright(counts[cell]!);
    if (level > 0) glowAt(image, cell % size, Math.floor(cell / size), [170, 235, 190], level);
  }
  return image;
};

/** Per-channel counts at each 8-bit level. */
export const levelCounts = (pixels: Uint8ClampedArray): { r: Uint32Array; g: Uint32Array; b: Uint32Array; samples: number } => {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const step = stride(pixels);
  let samples = 0;
  for (let p = 0; p < pixels.length / 4; p += step) {
    const at = p * 4;
    bump(r, pixels[at]!);
    bump(g, pixels[at + 1]!);
    bump(b, pixels[at + 2]!);
    samples += 1;
  }
  return { r, g, b, samples };
};

export const histogram = (pixels: Uint8ClampedArray, out = { width: 512, height: 256 }): ScopeImage => {
  const image = blank(out.width, out.height);
  for (const level of [0.25, 0.5, 0.75]) for (let y = 0; y < out.height; y += 2) add(image, Math.round(level * (out.width - 1)), y, GRATICULE, 1);
  const counts = levelCounts(pixels);
  // Scaled to the tallest level but one: a clipped spike at black or white would flatten the rest.
  const sorted = [...counts.r, ...counts.g, ...counts.b].sort((a, b) => b - a);
  const top = Math.max(1, sorted[3] ?? 1);
  const channels: [Uint32Array, [number, number, number]][] = [
    [counts.r, [200, 60, 60]],
    [counts.g, [60, 190, 90]],
    [counts.b, [70, 110, 230]],
  ];
  for (let x = 0; x < out.width; x += 1) {
    const level = Math.min(255, Math.floor((x / out.width) * 256));
    for (const [list, colour] of channels) {
      const height = Math.min(1, list[level]! / top) * (out.height - 1);
      for (let y = 0; y < height; y += 1) add(image, x, out.height - 1 - y, colour, 0.9);
    }
  }
  return image;
};

export const scope = (kind: ScopeKind, pixels: Uint8ClampedArray, width: number): ScopeImage => {
  if (kind === 'parade') return parade(pixels, width);
  if (kind === 'vectorscope') return vectorscope(pixels);
  if (kind === 'histogram') return histogram(pixels);
  return waveform(pixels, width);
};
