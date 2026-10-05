import type { KeyObject } from 'node:crypto';
import { planFrom, readToken, type Entitlement, type Plan } from './license-token';

/**
 * The license, as the desktop app keeps it.
 *
 * Activating is typing the authorization code from the purchase email: this
 * computer takes one of the subscription's two seats, and vc-dit.com answers
 * with a signed entitlement (license-token.ts) kept on disk with the code. No
 * email sign-in, because a DIT cart is often not a machine anyone reads email
 * on. The app checks in when it starts and every few hours; offline (and carts
 * often are) the last entitlement lasts its grace, 14 days.
 *
 * Without an active entitlement VC DIT still opens: productions, logs,
 * reports and manifests can be read and exported, but no new ingest or
 * delivery starts. A transfer already running always finishes and verifies:
 * licensing never interrupts a copy of camera originals.
 *
 * Kept free of Electron so it is tested with fakes; licensing-ipc.ts wires it
 * to the windows.
 */

export type AccessPlan = Plan | 'none';

export interface Access {
  plan: AccessPlan;
  /** licensed, or why not; not-configured is a developer build without the license keys. */
  state: 'licensed' | 'not-activated' | 'expired-offline' | 'not-configured';
  email: string | null;
  serial: string | null;
  paidThrough: string | null;
  validUntil: string | null;
  /** The last thing worth telling the customer (a refusal, a network problem). */
  message: string | null;
}

export interface Stored {
  token: string | null;
  /** The authorization code, encrypted at rest by the store where the system can. */
  code: string | null;
}

export interface LicensingConfig {
  siteUrl: string;
  publicKey: KeyObject | null;
}

export interface LicensingDeps {
  config: LicensingConfig;
  fetch: typeof fetch;
  load: () => Promise<Stored>;
  save: (stored: Stored) => Promise<void>;
  fingerprint: () => Promise<string>;
  device: () => { deviceName: string; platform: 'windows' | 'macos' | null; appVersion: string };
  now?: () => Date;
}

export const isConfigured = (config: LicensingConfig): boolean => Boolean(config.siteUrl && config.publicKey);

const EMPTY: Stored = { token: null, code: null };

export class Licensing {
  private stored: Stored = EMPTY;
  private fingerprintValue = '';
  private message: string | null = null;
  private listeners = new Set<(access: Access) => void>();

  constructor(private readonly deps: LicensingDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async start(): Promise<Access> {
    this.fingerprintValue = await this.deps.fingerprint();
    this.stored = { ...EMPTY, ...(await this.deps.load()) };
    return this.access();
  }

  onChange(listener: (access: Access) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private entitlement(): Entitlement | null {
    const key = this.deps.config.publicKey;
    return key && this.stored.token ? readToken(this.stored.token, key) : null;
  }

  access(): Access {
    const base = { message: this.message };
    if (!isConfigured(this.deps.config)) {
      return { ...base, plan: 'dit', state: 'not-configured', email: null, serial: null, paidThrough: null, validUntil: null };
    }
    const entitlement = this.entitlement();
    const plan = planFrom(entitlement, this.fingerprintValue, this.now());
    const facts = {
      email: entitlement?.email ?? null,
      serial: entitlement?.serial ?? null,
      paidThrough: entitlement?.paidThrough ?? null,
      validUntil: entitlement?.validUntil ?? null,
    };
    if (plan) return { ...base, ...facts, plan, state: 'licensed' };
    const state: Access['state'] = entitlement && entitlement.fingerprint === this.fingerprintValue ? 'expired-offline' : 'not-activated';
    return { ...base, ...facts, plan: 'none', state };
  }

  /** Whether a new ingest or delivery may start. One already running is never stopped. */
  canStartTransfers(): boolean {
    return this.access().plan !== 'none';
  }

  private async commit(patch: Partial<Stored>, message: string | null = this.message): Promise<Access> {
    this.stored = { ...this.stored, ...patch };
    this.message = message;
    await this.deps.save(this.stored);
    const access = this.access();
    for (const listener of this.listeners) listener(access);
    return access;
  }

  private async site(path: string, method: 'POST' | 'DELETE', body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await this.deps.fetch(`${this.deps.config.siteUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  }

  private deviceBody(): Record<string, unknown> | null {
    const device = this.deps.device();
    if (!device.platform) return null;
    return { fingerprint: this.fingerprintValue, deviceName: device.deviceName, platform: device.platform, appVersion: device.appVersion };
  }

  /** Take a seat with the authorization code, and keep the code and the entitlement. */
  async activate(code: string): Promise<Access> {
    const device = this.deviceBody();
    if (!device) return this.commit({}, 'VC DIT is licensed for macOS and Windows.');
    if (!code.trim()) return this.commit({}, 'Enter the authorization code from your purchase email.');
    try {
      const { status, json } = await this.site('/api/licenses/activate', 'POST', { ...device, code: code.trim() });
      if (status === 200 && typeof json['token'] === 'string') {
        const serial = readToken(json['token'], this.deps.config.publicKey!)?.serial ?? code.trim();
        return this.commit({ token: json['token'], code: serial }, null);
      }
      return this.commit({}, String(json['error'] ?? `Activation failed (${status}).`));
    } catch {
      return this.commit({}, 'Could not reach vc-dit.com. Check the connection and try again.');
    }
  }

  /**
   * The regular check-in. A fresh entitlement while the seat holds; the reason
   * when it does not. Offline, nothing changes: the last entitlement runs out
   * on its own date.
   */
  async refresh(): Promise<Access> {
    if (!isConfigured(this.deps.config) || !this.stored.code) return this.access();
    const device = this.deviceBody();
    if (!device) return this.access();
    try {
      const { status, json } = await this.site('/api/licenses/status', 'POST', { ...device, code: this.stored.code });
      if (status === 200 && typeof json['token'] === 'string') return this.commit({ token: json['token'] }, null);
      const reason = String(json['reason'] ?? '');
      // A code kept from an attempt whose answer never arrived: take the seat now.
      if (reason === 'not_activated' && !this.stored.token) return this.activate(this.stored.code);
      if (reason === 'device_removed' || reason === 'license_inactive' || reason === 'not_activated') {
        return this.commit({ token: null }, String(json['error'] ?? 'This computer is no longer licensed.'));
      }
      if (reason === 'unknown_code') {
        return this.commit({ token: null, code: null }, String(json['error'] ?? 'The authorization code is no longer valid.'));
      }
      return this.access();
    } catch {
      return this.access();
    }
  }

  /** Free this computer's seat and forget the code here. Media, logs and productions are untouched. */
  async deactivate(): Promise<Access> {
    try {
      if (this.stored.code) {
        await this.site('/api/licenses/devices', 'DELETE', { code: this.stored.code, fingerprint: this.fingerprintValue });
      }
    } catch {
      // Offline: the seat can be freed from the account page instead.
    }
    return this.commit({ ...EMPTY }, null);
  }
}
