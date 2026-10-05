import { describe, expect, it } from 'vitest';
import { generateSerial, isWellFormedSerial, normalizeSerial } from '../license';

describe('authorization codes', () => {
  it('reads aloud: VCDIT and four groups, no I, O, 0 or 1', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateSerial();
      expect(code).toMatch(/^VCDIT(-[A-HJ-NP-Z2-9]{5}){4}$/);
      expect(isWellFormedSerial(code)).toBe(true);
    }
  });

  it('accepts one typed loosely: lower case, spaces, no dashes, no prefix', () => {
    const code = generateSerial();
    const body = code.slice('VCDIT-'.length);
    expect(normalizeSerial(` ${code.toLowerCase()} `)).toBe(code);
    expect(normalizeSerial(body.replace(/-/g, ''))).toBe(code);
    expect(normalizeSerial(body.replace(/-/g, ' ').toLowerCase())).toBe(code);
    expect(isWellFormedSerial('VCW-AAAAA-AAAAA-AAAAA-AAAAA')).toBe(false);
    expect(isWellFormedSerial('VCDIT-AAAAA-AAAAA-AAAAA-AAAA0')).toBe(false);
  });

  it('are not all the same', () => {
    expect(new Set(Array.from({ length: 200 }, generateSerial)).size).toBe(200);
  });
});
