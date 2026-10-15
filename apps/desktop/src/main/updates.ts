/**
 * Whether a newer VC DIT is out: the site's public list of current releases
 * (vc-dit.com/api/releases: version and notes per platform, never where the
 * installer is), compared with this copy's version. Checked at start and
 * every few hours. The installer itself is fetched the usual way, from the
 * site's download page, through the license, so an update needs nothing the
 * app does not already have.
 *
 * The person can put a notice off until tomorrow, or skip that version; a
 * later version is announced again.
 */

import type { UpdateState } from '../shared/updates';

export type { UpdateState };
export type ReleasePlatform = 'windows' | 'macos';

export interface Kept {
  skipped: string | null;
  /** Epoch ms: the notice stays down until then. */
  snoozedUntil: number;
}

export interface UpdaterDeps {
  site: string;
  current: string;
  platform: ReleasePlatform | null;
  fetch: typeof fetch;
  now: () => number;
  load: () => Promise<Kept>;
  save: (kept: Kept) => Promise<void>;
  changed: (state: UpdateState) => void;
}

/** Major, minor, patch, then a pre-release (which comes before the release itself). */
const parse = (version: string): { parts: [number, number, number]; pre: string | null } | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  if (!match) return null;
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
};

/** Is `candidate` a later version than `current`? Unreadable versions are never newer. */
export const isNewer = (candidate: string, current: string): boolean => {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a.parts[i] !== b.parts[i]) return a.parts[i]! > b.parts[i]!;
  if (a.pre === b.pre) return false;
  if (a.pre === null) return true;
  if (b.pre === null) return false;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
};

export const releasePlatform = (platform: string): ReleasePlatform | null => (platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : null);

const DAY = 24 * 60 * 60 * 1000;

export class Updater {
  private kept: Kept = { skipped: null, snoozedUntil: 0 };
  private state: UpdateState;

  constructor(private readonly deps: UpdaterDeps) {
    this.state = { current: deps.current, available: null, showing: false, checking: false, checkedAt: null, error: null };
  }

  async start(): Promise<void> {
    this.kept = await this.deps.load().catch(() => ({ skipped: null, snoozedUntil: 0 }));
  }

  view(): UpdateState {
    return this.state;
  }

  private set(patch: Partial<UpdateState>) {
    const next = { ...this.state, ...patch };
    const available = next.available;
    next.showing = available !== null && available.version !== this.kept.skipped && this.deps.now() >= this.kept.snoozedUntil;
    this.state = next;
    this.deps.changed(next);
  }

  /** Ask the site. Never throws: a check that cannot answer says why and leaves what was known. */
  async check(): Promise<UpdateState> {
    if (!this.deps.platform) return this.state;
    this.set({ checking: true });
    try {
      const response = await this.deps.fetch(`${this.deps.site}/api/releases`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`the site answered ${response.status}`);
      const body = (await response.json()) as { releases?: { platform?: string; version?: string; release_notes?: string; minimum_os_version?: string; published_at?: string }[] };
      const release = (body.releases ?? []).find((item) => item.platform === this.deps.platform);
      const available =
        release?.version && isNewer(release.version, this.deps.current)
          ? { version: release.version, notes: release.release_notes ?? '', minimumOs: release.minimum_os_version ?? null, publishedAt: release.published_at ?? null }
          : null;
      this.set({ available, checking: false, checkedAt: new Date(this.deps.now()).toISOString(), error: null });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.set({ checking: false, error: /fetch failed|ENOTFOUND|ECONN|network/i.test(reason) ? 'VC DIT could not reach vc-dit.com.' : `Could not check: ${reason}.` });
    }
    return this.state;
  }

  /** Put the notice off: until tomorrow, or for good for this version. */
  async dismiss(how: 'later' | 'skip'): Promise<UpdateState> {
    if (how === 'skip' && this.state.available) this.kept = { ...this.kept, skipped: this.state.available.version };
    else this.kept = { ...this.kept, snoozedUntil: this.deps.now() + DAY };
    await this.deps.save(this.kept).catch(() => undefined);
    this.set({});
    return this.state;
  }
}
