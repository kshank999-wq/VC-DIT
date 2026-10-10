import { dirname, join } from 'node:path';
import { SCENE_VIEW, SELECTS_VIEW, type OrganizeState } from '../../shared/project';
import type { OrganizeLink, OrganizeView, ProductionDb } from '../db/production-db';
import { buildView, removeView } from './view';

/**
 * Keeps the scene view and the selects (src/main/organize/view.ts) in step
 * with the day: every verified clip placed by its take, on every destination
 * holding it; a clip whose take changed moved; a circle no longer circled
 * taken out of the selects. Links and references are instant, so this runs
 * after each card, log import and match decision. One run at a time; a
 * request during a run starts another when it ends.
 */

export interface OrganizeDeps {
  db: () => ProductionDb;
  changed: () => void;
}

/** The day folder a card folder sits in: DAY/CAMERA_ORIGINALS/CARD. */
export const dayOfCard = (cardDir: string): string => dirname(dirname(cardDir));

/** The folder a view's clips sit under, which a removal never goes above. */
export const viewRoot = (dayDir: string, kind: OrganizeView['kind']): string => join(dayDir, ...(kind === 'scene' ? SCENE_VIEW : SELECTS_VIEW).split('/'));

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const EMPTY_ORGANIZE: OrganizeState = { placed: 0, references: 0, failed: 0, pending: 0, folders: [], problems: [], activity: null };

export class OrganizeService {
  private state: OrganizeState & { key: string } = { ...EMPTY_ORGANIZE, key: '' };
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: OrganizeDeps) {}

  private key() {
    const db = this.deps.db();
    return `${db.file}|${db.currentDay().number}`;
  }

  /** The view as last made, if that was this production's open day. */
  view(): OrganizeState {
    const { key, ...state } = this.state;
    return key === this.key() ? state : EMPTY_ORGANIZE;
  }

  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.work();
        } catch {
          // The database closed or switched mid-run; the next run starts afresh.
        }
      } while (this.again);
    })().finally(() => {
      this.running = null;
      this.state.activity = null;
      this.deps.changed();
    });
    return this.running;
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async work() {
    const db = this.deps.db();
    const key = this.key();
    const day = db.currentDay().number;
    const views = db.organizeViews(day);
    const links = db.organizeLinks(day);
    const id = (item: { kind: string; card: string; clip: string; legId: string }) => `${item.kind}|${item.card}|${item.clip}|${item.legId}`;
    const wanted = new Map<string, { view: OrganizeView; location: OrganizeView['locations'][number] }>();
    for (const view of views) for (const location of view.locations) wanted.set(id({ ...view, legId: location.legId }), { view, location });

    // First take down what moved or no longer belongs, so a new name never meets an old folder.
    for (const link of links) {
      const want = wanted.get(id(link));
      if (want && want.view.relDir === link.relDir) continue;
      await removeView(link.targetDir, link.cardDir, viewRoot(dayOfCard(link.cardDir), link.kind));
      if (this.deps.db() !== db) return;
      db.removeOrganize(day, link);
    }

    const current = new Map(db.organizeLinks(day).map((link) => [id(link), link]));
    const todo = [...wanted.entries()].filter(([key]) => current.get(key)?.state !== 'placed');
    for (const [index, [, { view, location }]] of todo.entries()) {
      if (index % 25 === 0) {
        this.state = { ...this.state, activity: `Placing clips in scene folders (${index + 1} of ${todo.length})…` };
        this.deps.changed();
      }
      const targetDir = join(dayOfCard(location.cardDir), ...view.relDir.split('/'));
      const link: OrganizeLink = {
        kind: view.kind,
        card: view.card,
        clip: view.clip,
        legId: location.legId,
        destination: location.name,
        relDir: view.relDir,
        targetDir,
        cardDir: location.cardDir,
        method: 'Hard link',
        state: 'placed',
        error: null,
      };
      try {
        link.method = await buildView(location.cardDir, targetDir, view);
      } catch (cause) {
        link.state = 'failed';
        link.error = message(cause);
      }
      if (this.deps.db() !== db) return;
      db.saveOrganize(day, link);
    }

    // What the screens show: the scene view only (the selects are the same clips again).
    const placed = db.organizeLinks(day).filter((link) => link.kind === 'scene');
    const done = placed.filter((link) => link.state === 'placed');
    const sceneWanted = [...wanted.values()].filter(({ view }) => view.kind === 'scene').length;
    const folders = new Map<string, string>();
    for (const link of done) folders.set(link.destination, viewRoot(dayOfCard(link.cardDir), 'scene'));
    this.state = {
      key,
      placed: done.length,
      references: done.filter((link) => link.method === 'Reference').length,
      failed: placed.length - done.length,
      pending: Math.max(0, sceneWanted - placed.length),
      folders: [...folders].map(([destination, path]) => ({ destination, path })),
      problems: placed
        .filter((link) => link.state === 'failed')
        .slice(0, 20)
        .map((link) => ({ clip: link.clip, destination: link.destination, error: link.error ?? 'Not placed.' })),
      activity: null,
    };
  }
}
