import { describe, expect, it } from 'vitest';
import { decideActivation, explainRefusal } from '../activation';

const license = { id: 'L', status: 'active' as const, maxActivations: 2 };
const seat = (fingerprint: string, freed = false) => ({ licenseId: 'L', deviceFingerprint: fingerprint, deactivatedAt: freed ? '2026-01-01' : null });

describe('seats', () => {
  it('takes a free seat, and a reinstall does not take a second one', () => {
    expect(decideActivation(license, [], 'a')).toEqual({ result: 'activated', reason: 'new_device' });
    expect(decideActivation(license, [seat('a')], 'a')).toEqual({ result: 'activated', reason: 'already_active' });
  });

  it('refuses a third computer, and says where to free a seat', () => {
    const outcome = decideActivation(license, [seat('a'), seat('b')], 'c');
    expect(outcome).toEqual({ result: 'refused', reason: 'no_slots', inUse: 2, limit: 2 });
    if (outcome.result === 'refused') expect(explainRefusal(outcome)).toMatch(/account/);
  });

  it('lets a freed computer come back, or a new one take its place', () => {
    expect(decideActivation(license, [seat('a', true), seat('b')], 'a')).toEqual({ result: 'activated', reason: 'reactivated' });
    expect(decideActivation(license, [seat('a', true), seat('b')], 'c')).toEqual({ result: 'activated', reason: 'new_device' });
  });

  it('refuses everything on a license that is not active', () => {
    expect(decideActivation({ ...license, status: 'expired' }, [seat('a')], 'a')).toEqual({ result: 'refused', reason: 'license_inactive' });
  });
});
