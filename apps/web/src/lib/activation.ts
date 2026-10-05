/**
 * Device seats (VC Writer's activation rules, for a subscription license).
 *
 * A seat is an installation, identified by a fingerprint the app makes on
 * first run. Reinstalling must not burn a second seat; a device that freed its
 * seat and comes back reclaims its own record; a new device takes a free seat
 * or is told plainly that both are in use and where to free one. A freed seat
 * is kept as a record, not deleted, so support can see what happened.
 */

export interface SeatLicense {
  id: string;
  status: 'active' | 'suspended' | 'revoked' | 'expired';
  maxActivations: number;
}

export interface Seat {
  licenseId: string;
  deviceFingerprint: string;
  deactivatedAt: string | null;
}

export type ActivationOutcome =
  | { result: 'activated'; reason: 'new_device' | 'already_active' | 'reactivated' }
  | { result: 'refused'; reason: 'license_inactive' }
  | { result: 'refused'; reason: 'no_slots'; inUse: number; limit: number };

export const decideActivation = (license: SeatLicense, seats: readonly Seat[], fingerprint: string): ActivationOutcome => {
  if (license.status !== 'active') return { result: 'refused', reason: 'license_inactive' };
  const own = seats.filter((seat) => seat.licenseId === license.id);
  const existing = own.find((seat) => seat.deviceFingerprint === fingerprint);
  if (existing && existing.deactivatedAt === null) return { result: 'activated', reason: 'already_active' };
  const inUse = own.filter((seat) => seat.deactivatedAt === null).length;
  if (inUse >= license.maxActivations) return { result: 'refused', reason: 'no_slots', inUse, limit: license.maxActivations };
  return { result: 'activated', reason: existing ? 'reactivated' : 'new_device' };
};

export const explainRefusal = (outcome: Extract<ActivationOutcome, { result: 'refused' }>): string =>
  outcome.reason === 'no_slots'
    ? `This subscription is already on ${outcome.inUse} of ${outcome.limit} computers. Free one under Devices on your account page at vc-dit.com/account, then try again.`
    : 'This subscription is not active. Your subscription may have ended; see your account page at vc-dit.com/account.';

/** A name the owner will recognise in their list of devices. */
export const describeDevice = (seat: { deviceName: string; platform: 'windows' | 'macos' }): string =>
  `${seat.deviceName || 'Unnamed computer'} · ${seat.platform === 'macos' ? 'Mac' : 'Windows'}`;
