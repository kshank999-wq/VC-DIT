import type { KeyObject } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decideActivation, explainRefusal, type ActivationOutcome, type Seat, type SeatLicense } from './activation';
import { issueEntitlement, type Entitlement } from './entitlement';
import type { Plan } from './env';
import { isWellFormedSerial, normalizeSerial } from './license';
import type { LicenseStatus } from './plans';

/**
 * Seats and entitlements, against the license tables. The rules are in
 * activation.ts and plans.ts; this is where they meet rows. The client and the
 * signing key are arguments so the sequencing is tested against a fake.
 *
 * The desktop app identifies itself with the authorization code it was
 * activated with (license.ts explains why the code is the credential) plus
 * this computer's fingerprint. The account page identifies the customer by
 * their signed-in session instead, and can free any of their seats.
 */

export type Platform = 'windows' | 'macos';

interface LicenseRow {
  id: string;
  user_id: string;
  serial: string;
  plan: Plan;
  status: LicenseStatus;
  max_activations: number;
  paid_through: string | null;
}

interface SeatRow {
  id: string;
  license_id: string;
  device_fingerprint: string;
  device_name: string;
  platform: Platform;
  app_version: string;
  activated_at: string;
  last_seen_at: string | null;
  deactivated_at: string | null;
}

export interface DeviceInput {
  fingerprint: string;
  deviceName: string;
  platform: Platform;
  appVersion: string;
}

export type EntitlementResult =
  | { ok: true; token: string; entitlement: Entitlement }
  | {
      ok: false;
      reason: 'unknown_code' | 'license_inactive' | 'no_slots' | 'device_removed' | 'not_activated' | 'error';
      message: string;
      outcome?: ActivationOutcome;
    };

const LICENSE_COLUMNS = 'id, user_id, serial, plan, status, max_activations, paid_through';

const UNKNOWN_CODE =
  'That authorization code was not recognised. Check it against your email or your account page at vc-dit.com/account.';

const licenseByCode = async (client: SupabaseClient, code: string): Promise<LicenseRow | null> => {
  if (!isWellFormedSerial(code)) return null;
  const { data } = await client.from('licenses').select(LICENSE_COLUMNS).eq('serial', normalizeSerial(code)).maybeSingle();
  return (data as LicenseRow | null) ?? null;
};

const licensesOf = async (client: SupabaseClient, userId: string): Promise<LicenseRow[]> => {
  const { data } = await client.from('licenses').select(LICENSE_COLUMNS).eq('user_id', userId);
  return (data ?? []) as LicenseRow[];
};

const seatsOf = async (client: SupabaseClient, licenseIds: string[]): Promise<SeatRow[]> => {
  if (licenseIds.length === 0) return [];
  const { data } = await client.from('device_activations').select('*').in('license_id', licenseIds);
  return (data ?? []) as SeatRow[];
};

const ownerEmail = async (client: SupabaseClient, userId: string): Promise<string> => {
  const { data } = await client.from('profiles').select('email').eq('id', userId).maybeSingle();
  return (data?.email as string | undefined) ?? '';
};

const asSeatLicense = (row: LicenseRow): SeatLicense => ({ id: row.id, status: row.status, maxActivations: row.max_activations });
const asSeat = (row: SeatRow): Seat => ({ licenseId: row.license_id, deviceFingerprint: row.device_fingerprint, deactivatedAt: row.deactivated_at });

const entitle = async (client: SupabaseClient, license: LicenseRow, fingerprint: string, key: KeyObject): Promise<EntitlementResult> => {
  const { token, entitlement } = issueEntitlement(
    {
      serial: license.serial,
      plan: license.plan,
      fingerprint,
      email: await ownerEmail(client, license.user_id),
      paidThrough: license.paid_through,
    },
    key,
  );
  return { ok: true, token, entitlement };
};

/** Put this computer on the license the authorization code names. */
export const activateDevice = async (
  code: string,
  device: DeviceInput,
  client: SupabaseClient,
  key: KeyObject,
): Promise<EntitlementResult> => {
  const license = await licenseByCode(client, code);
  if (!license) return { ok: false, reason: 'unknown_code', message: UNKNOWN_CODE };

  const seats = await seatsOf(client, [license.id]);
  const outcome = decideActivation(asSeatLicense(license), seats.map(asSeat), device.fingerprint);
  if (outcome.result === 'refused') {
    return { ok: false, reason: outcome.reason, message: explainRefusal(outcome), outcome };
  }

  const now = new Date().toISOString();
  const { error } = await client.from('device_activations').upsert(
    {
      license_id: license.id,
      device_fingerprint: device.fingerprint,
      device_name: device.deviceName,
      platform: device.platform,
      app_version: device.appVersion,
      activated_at: now,
      last_seen_at: now,
      deactivated_at: null,
    },
    { onConflict: 'license_id,device_fingerprint' },
  );
  if (error) return { ok: false, reason: 'error', message: 'The activation could not be recorded. Try again in a moment.' };
  return entitle(client, license, device.fingerprint, key);
};

/**
 * The app's regular check: is this computer still on an active license? A
 * fresh entitlement if so. A seat freed from the account page, or a license
 * whose subscription ended, says so.
 */
export const checkDevice = async (
  code: string,
  device: DeviceInput,
  client: SupabaseClient,
  key: KeyObject,
): Promise<EntitlementResult> => {
  const license = await licenseByCode(client, code);
  if (!license) return { ok: false, reason: 'unknown_code', message: UNKNOWN_CODE };
  const seat = (await seatsOf(client, [license.id])).find((candidate) => candidate.device_fingerprint === device.fingerprint);
  if (!seat) return { ok: false, reason: 'not_activated', message: 'This computer is not activated yet.' };
  if (seat.deactivated_at !== null) {
    return {
      ok: false,
      reason: 'device_removed',
      message: 'This computer was removed from your subscription on the account page. Activate it again to keep working.',
    };
  }
  if (license.status !== 'active') {
    return { ok: false, reason: 'license_inactive', message: explainRefusal({ result: 'refused', reason: 'license_inactive' }) };
  }
  await client
    .from('device_activations')
    .update({ last_seen_at: new Date().toISOString(), app_version: device.appVersion })
    .eq('id', seat.id);
  return entitle(client, license, device.fingerprint, key);
};

/** The app freeing its own seat (Deactivate this computer), by its code and fingerprint. */
export const deactivateByCode = async (
  code: string,
  fingerprint: string,
  client: SupabaseClient,
): Promise<{ ok: boolean; error: string | null }> => {
  const license = await licenseByCode(client, code);
  if (!license) return { ok: false, error: UNKNOWN_CODE };
  const seat = (await seatsOf(client, [license.id])).find(
    (candidate) => candidate.device_fingerprint === fingerprint && candidate.deactivated_at === null,
  );
  if (!seat) return { ok: false, error: 'This computer is not activated.' };
  const { error } = await client.from('device_activations').update({ deactivated_at: new Date().toISOString() }).eq('id', seat.id);
  return error ? { ok: false, error: error.message } : { ok: true, error: null };
};

/** The account page freeing any of the signed-in customer's seats (the lost-laptop case). */
export const deactivateDevice = async (
  userId: string,
  activationId: string,
  client: SupabaseClient,
): Promise<{ ok: boolean; error: string | null }> => {
  const licenses = await licensesOf(client, userId);
  const seats = await seatsOf(client, licenses.map((license) => license.id));
  const seat = seats.find((candidate) => candidate.id === activationId && candidate.deactivated_at === null);
  if (!seat) return { ok: false, error: 'That computer is not on a subscription of yours.' };
  const { error } = await client.from('device_activations').update({ deactivated_at: new Date().toISOString() }).eq('id', seat.id);
  return error ? { ok: false, error: error.message } : { ok: true, error: null };
};

export interface DeviceView {
  id: string;
  name: string;
  platform: Platform;
  appVersion: string;
  activatedAt: string;
  lastSeenAt: string | null;
  deactivatedAt: string | null;
  serial: string;
}

export const listDevices = async (userId: string, client: SupabaseClient): Promise<DeviceView[]> => {
  const licenses = await licensesOf(client, userId);
  const seats = await seatsOf(client, licenses.map((license) => license.id));
  return seats
    .map((seat) => ({
      id: seat.id,
      name: seat.device_name,
      platform: seat.platform,
      appVersion: seat.app_version,
      activatedAt: seat.activated_at,
      lastSeenAt: seat.last_seen_at,
      deactivatedAt: seat.deactivated_at,
      serial: licenses.find((license) => license.id === seat.license_id)?.serial ?? '',
    }))
    .sort((a, b) => Number(a.deactivatedAt !== null) - Number(b.deactivatedAt !== null) || b.activatedAt.localeCompare(a.activatedAt));
};

/** The download route: is this code a license that may download right now? */
export const codeMayDownload = async (code: string, client: SupabaseClient): Promise<boolean> =>
  (await licenseByCode(client, code))?.status === 'active';
