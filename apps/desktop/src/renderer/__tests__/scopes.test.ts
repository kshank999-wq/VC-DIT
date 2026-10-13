import { describe, expect, it } from 'vitest';
import { CHART_PATCHES, testChart } from '../grade/chart';
import { histogram, levelCounts, parade, vectorPoint, vectorscope, VECTOR_TARGETS, waveform } from '../grade/scopes';

const pixel = (rgb: [number, number, number]) => new Uint8ClampedArray([...rgb, 255]);

describe('scopes', () => {
  const flat = (rgb: [number, number, number], count = 400) => {
    const pixels = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i += 1) pixels.set(pixel(rgb), i * 4);
    return pixels;
  };
  const lit = (image: { width: number; data: Uint8ClampedArray }, x: number, y: number) => {
    const at = (y * image.width + x) * 4;
    return image.data[at]! + image.data[at + 1]! + image.data[at + 2]!;
  };

  it('puts mid grey half way up the waveform, and nothing else lit but the graticule', () => {
    const image = waveform(flat([128, 128, 128]), 20, { width: 64, height: 101 });
    const row = 100 - Math.round((128 / 255) * 100);
    expect(lit(image, 0, row)).toBeGreaterThan(400);
    expect(lit(image, 10, 10)).toBe(0);
  });

  it('separates the channels in the parade', () => {
    const image = parade(flat([255, 0, 0]), 20, { width: 90, height: 51 });
    // Red at the top of the first third; green and blue at the bottom of theirs.
    expect(image.data[(0 * 90 + 10) * 4]).toBeGreaterThan(200);
    expect(image.data[(50 * 90 + 45) * 4 + 1]).toBeGreaterThan(150);
    expect(image.data[(50 * 90 + 80) * 4 + 2]).toBeGreaterThan(150);
  });

  it('lands 75 % bars in their targets, and grey at the centre of the vectorscope', () => {
    for (const target of VECTOR_TARGETS) {
      const [u, v] = vectorPoint(...target.rgb);
      const image = vectorscope(flat(target.rgb.map((value) => Math.round(value * 255)) as [number, number, number]), 128);
      expect(lit(image, Math.round(u * 127), Math.round(v * 127))).toBeGreaterThan(300);
    }
    expect(vectorPoint(0.5, 0.5, 0.5)).toEqual([0.5, 0.5]);
    // Red is up and a little left; blue is right.
    const [ru, rv] = vectorPoint(0.75, 0, 0);
    expect(rv).toBeLessThan(0.2);
    expect(ru).toBeLessThan(0.5);
    expect(vectorPoint(0, 0, 0.75)[0]).toBeGreaterThan(0.8);
  });

  it('counts each level in the histogram', () => {
    const counts = levelCounts(new Uint8ClampedArray([0, 10, 255, 255, 0, 10, 20, 255]));
    expect([counts.r[0], counts.g[10], counts.b[255], counts.b[20], counts.samples]).toEqual([2, 2, 1, 1, 2]);
    const image = histogram(flat([0, 128, 255]), { width: 256, height: 50 });
    expect(image.data[(49 * 256 + 128) * 4 + 1]).toBeGreaterThan(100);
  });
});

describe('the test chart', () => {
  it('has bars on top, a ramp, and the patches along the bottom', () => {
    const pixels = testChart(60, 100);
    const at = (x: number, y: number) => [...pixels.subarray((y * 60 + x) * 4, (y * 60 + x) * 4 + 3)];
    expect(at(0, 0)).toEqual([191, 191, 191]);
    expect(at(59, 60)).toEqual([255, 255, 255]);
    expect(at(0, 99)).toEqual(CHART_PATCHES[0]!.map((value) => Math.round(value * 255)));
  });
});
