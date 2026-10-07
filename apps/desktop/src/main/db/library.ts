import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Production, ProjectState } from '../../shared/project';
import { ProductionDb } from './production-db';

/**
 * The productions on this cart: which one is open, and the ones opened
 * before. New productions are made in the app's data folder; any production
 * file can be opened from anywhere (the RAID, a shuttle, a colleague's copy).
 */

export const PRODUCTION_EXTENSION = 'vcdit';

interface Index {
  current: string | null;
  recent: { file: string; name: string }[];
}

const slug = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'production';

export class Library {
  private index: Index = { current: null, recent: [] };
  private db: ProductionDb | null = null;

  constructor(private readonly deps: { dir: string; wasm: string; saveDelayMs?: number }) {}

  private indexFile() {
    return join(this.deps.dir, 'library.json');
  }

  private async saveIndex() {
    await mkdir(this.deps.dir, { recursive: true });
    await writeFile(this.indexFile(), JSON.stringify(this.index, null, 2), 'utf8');
  }

  /** Open the production used last, or start a first one. */
  async start(): Promise<ProductionDb> {
    try {
      this.index = { current: null, recent: [], ...(JSON.parse(await readFile(this.indexFile(), 'utf8')) as Partial<Index>) };
    } catch {
      // First run.
    }
    if (this.index.current) {
      try {
        return await this.open(this.index.current);
      } catch {
        // Moved or unreadable: start a fresh one rather than not open at all. It stays in the recent list.
      }
    }
    return this.create({});
  }

  get current(): ProductionDb {
    if (!this.db) throw new Error('No production is open.');
    return this.db;
  }

  async create(production: Partial<Production>): Promise<ProductionDb> {
    const productions = join(this.deps.dir, 'productions');
    await mkdir(productions, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    // Never an existing file's name, even for two productions made in the same second.
    const file = join(productions, `${slug(production.name ?? 'Untitled production')}-${stamp}-${randomBytes(3).toString('hex')}.${PRODUCTION_EXTENSION}`);
    const db = await ProductionDb.open(file, { wasm: this.deps.wasm, create: production, saveDelayMs: this.deps.saveDelayMs });
    return this.use(db);
  }

  async open(file: string): Promise<ProductionDb> {
    if (this.db?.file === file) return this.db;
    const db = await ProductionDb.open(file, { wasm: this.deps.wasm, saveDelayMs: this.deps.saveDelayMs });
    return this.use(db);
  }

  private async use(db: ProductionDb): Promise<ProductionDb> {
    const previous = this.db;
    this.db = db;
    if (previous && previous !== db) await previous.close();
    this.index.current = db.file;
    this.remember();
    await this.saveIndex();
    return db;
  }

  /** Keep the recent list's name in step with the open production. */
  remember() {
    if (!this.db) return;
    const entry = { file: this.db.file, name: this.db.production().name };
    this.index.recent = [entry, ...this.index.recent.filter((item) => item.file !== entry.file)].slice(0, 12);
  }

  async rememberAndSave() {
    this.remember();
    await this.saveIndex();
  }

  state(): ProjectState {
    const db = this.current;
    const day = db.currentDay();
    return {
      file: db.file,
      production: db.production(),
      day,
      days: db.days(),
      ...db.logView(day.number),
      vfxActivity: null,
      sync: db.syncView(day.number),
      syncActivity: null,
      luts: db.luts(),
      lutRules: db.lutRules(day.number),
      previewClips: db.previewClips(day.number).map(({ id, label }) => ({ id, label })),
      dailies: db.dailiesSettings(),
      renders: db.renders(day.number).map(({ checksum: _checksum, ...render }) => render),
      dailiesActivity: null,
      ffmpeg: null,
      delivery: {
        settings: db.deliverySettings(),
        places: [],
        parts: [],
        scanning: false,
        scannedAt: null,
        records: db.deliveries(day.number).map(({ root: _root, failedFiles: _files, ...record }) => record),
        activity: null,
        error: null,
      },
      recent: this.index.recent,
    };
  }

  async close(): Promise<void> {
    await this.db?.close();
    this.db = null;
  }
}
