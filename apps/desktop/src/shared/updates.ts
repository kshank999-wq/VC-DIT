/** Whether a newer VC DIT is out, as the update check (src/main/updates.ts) tells the window. */
export interface UpdateState {
  current: string;
  /** The newest release for this platform, when it is newer than this copy. */
  available: { version: string; notes: string; minimumOs: string | null; publishedAt: string | null } | null;
  /** The notice is up: something is available, and it has not been put off or skipped. */
  showing: boolean;
  checking: boolean;
  /** When the site last answered. */
  checkedAt: string | null;
  /** Why the last check did not answer (no network, the site down); quiet until asked. */
  error: string | null;
}
