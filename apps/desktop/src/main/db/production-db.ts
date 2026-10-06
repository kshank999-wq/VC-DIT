import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import type { ChecksumMethod } from '../../shared/media';
import { DEFAULT_NAMING, localDate, type Production, type SceneEntry, type SceneStatus, type ShootDay } from '../../shared/project';
import type { FileOutcome, SourceFile } from '../media/transfer';

/**
 * One production's database: a single SQLite file on the cart (spec §2
 * "the media index"), so on set it needs no connection, and the whole
 * production can be copied, archived or handed over as one file.
 *
 * SQLite runs as WebAssembly (sql.js), so there is no native module to build
 * for each platform. The database lives in memory and is written back to its
 * file half a second after a change: to a temporary file first, then renamed
 * over the old one, so a crash mid-write never leaves a broken database.
 * Opening a file also keeps the previous version as `<file>.bak`.
 */

export interface TransferRecord {
  id: string;
  day: number;
  card: string;
  label: string;
  sourceRoot: string;
  sound: boolean;
  checksum: ChecksumMethod;
  startedAt: string | null;
  finishedAt: string | null;
  files: (SourceFile & { hash: string | null; hashedAt: string | null })[];
  destinations: {
    id: string;
    name: string;
    root: string;
    targetDir: string;
    reportsDir: string;
    error: string | null;
    outcomes: Record<string, FileOutcome>;
  }[];
}

/** Each entry moves the schema one version on; never edit one that has shipped. */
const MIGRATIONS: string[] = [
  `
  create table production (
    id integer primary key check (id = 1),
    name text not null,
    code text not null,
    frame_rate text not null,
    checksum text not null,
    total_days integer not null,
    devices text not null default '[]',
    naming_tokens text not null default '[]',
    current_day integer not null default 1,
    created_at text not null,
    updated_at text not null
  );

  create table shoot_day (
    number integer primary key,
    date text not null,
    locations text not null default '',
    operator_name text not null default '',
    operator_initials text not null default '',
    created_at text not null
  );

  -- The day's scene list (spec §4.1), in the order it was entered.
  create table scene (
    day integer not null,
    id text not null,
    description text not null default '',
    status text not null default 'Scheduled',
    notes text not null default '',
    look text not null default '',
    position integer not null,
    primary key (day, id)
  );

  -- One card's ingest (spec "Transfer Record").
  create table transfer (
    id text not null,
    day integer not null,
    card text not null,
    label text not null,
    source_root text not null,
    sound integer not null,
    checksum text not null,
    started_at text,
    finished_at text,
    primary key (day, id)
  );

  create table transfer_destination (
    day integer not null,
    transfer_id text not null,
    leg_id text not null,
    position integer not null,
    name text not null,
    root text not null,
    target_dir text not null,
    reports_dir text not null,
    error text,
    primary key (day, transfer_id, leg_id)
  );

  -- Every file of every card (spec "Clip / Audio File"): its original name and
  -- path on the card, and the checksum it was copied with.
  create table clip (
    id integer primary key,
    day integer not null,
    transfer_id text not null,
    card text not null,
    path text not null,
    file_name text not null,
    kind text not null check (kind in ('camera', 'sound')),
    size integer not null,
    mtime_ms real not null,
    checksum_method text not null,
    checksum text,
    hashed_at text,
    unique (day, transfer_id, path)
  );

  -- Where each clip was copied, and whether that copy verified.
  create table clip_copy (
    clip_id integer not null,
    leg_id text not null,
    state text not null check (state in ('verified', 'already-there', 'failed')),
    error text,
    primary key (clip_id, leg_id)
  );

  create index clip_card_idx on clip (day, card);
  create index clip_name_idx on clip (file_name);
  `,
];

let sql: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null;
const engine = (wasm: string) => (sql ??= readFile(wasm).then((binary) => initSqlJs({ wasmBinary: binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer })));

const now = () => new Date().toISOString();

export const DEFAULT_PRODUCTION: Production = {
  name: 'Untitled production',
  code: 'PROD',
  frameRate: '23.976 fps',
  checksum: 'xxHash64',
  totalDays: 30,
  devices: [],
  namingTokens: DEFAULT_NAMING,
};

export class ProductionDb {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly db: Database,
    readonly file: string,
    private readonly saveDelayMs: number,
  ) {}

  /** Open a production file, or make a new one there. */
  static async open(file: string, options: { wasm: string; create?: Partial<Production>; saveDelayMs?: number }): Promise<ProductionDb> {
    const SQL = await engine(options.wasm);
    let bytes: Uint8Array | null = null;
    try {
      bytes = await readFile(file);
    } catch (cause) {
      if ((cause as { code?: string }).code !== 'ENOENT' || !options.create) throw cause;
    }
    let db: Database;
    try {
      db = new SQL.Database(bytes ?? undefined);
      db.exec('select count(*) from sqlite_master');
    } catch {
      throw new Error('That file is not a VC DIT production database.');
    }
    const production = new ProductionDb(db, file, options.saveDelayMs ?? 500);
    if (bytes) {
      if (!production.isProduction()) throw new Error('That file is not a VC DIT production database.');
      await copyFile(file, `${file}.bak`).catch(() => undefined);
    }
    production.migrate();
    if (!bytes) {
      production.create({ ...DEFAULT_PRODUCTION, ...options.create });
      await production.flush();
    }
    return production;
  }

  private isProduction(): boolean {
    const version = this.value<number>('pragma user_version') ?? 0;
    return version === 0 ? this.rows('select name from sqlite_master').length === 0 : this.rows("select 1 from sqlite_master where name = 'production'").length > 0;
  }

  private migrate() {
    const version = this.value<number>('pragma user_version') ?? 0;
    if (version > MIGRATIONS.length) throw new Error('This production was saved by a newer VC DIT. Update the app to open it.');
    for (let next = version; next < MIGRATIONS.length; next += 1) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[next]!);
        this.db.exec(`pragma user_version = ${next + 1}`);
      });
    }
  }

  private create(production: Production) {
    const at = now();
    this.transaction(() => {
      this.run(
        `insert into production (id, name, code, frame_rate, checksum, total_days, devices, naming_tokens, current_day, created_at, updated_at)
         values (1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [production.name, production.code, production.frameRate, production.checksum, production.totalDays, JSON.stringify(production.devices), JSON.stringify(production.namingTokens), at, at],
      );
      this.run('insert into shoot_day (number, date, created_at) values (1, ?, ?)', [localDate(), at]);
    });
  }

  // ------------------------------------------------ plumbing

  private run(statement: string, params: SqlValue[] = []) {
    this.db.run(statement, params);
  }

  private rows<T = Record<string, SqlValue>>(statement: string, params: SqlValue[] = []): T[] {
    const prepared = this.db.prepare(statement);
    try {
      prepared.bind(params);
      const out: T[] = [];
      while (prepared.step()) out.push(prepared.getAsObject() as T);
      return out;
    } finally {
      prepared.free();
    }
  }

  private value<T extends SqlValue>(statement: string, params: SqlValue[] = []): T | null {
    const result = this.db.exec(statement, params);
    return (result[0]?.values[0]?.[0] as T | undefined) ?? null;
  }

  private transaction(work: () => void) {
    this.db.exec('begin');
    try {
      work();
      this.db.exec('commit');
    } catch (cause) {
      this.db.exec('rollback');
      throw cause;
    }
    this.changed();
  }

  private changed() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.saveDelayMs);
    this.timer.unref?.();
  }

  /** Write the database to its file now (and wait for any write already going). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const bytes = this.db.export();
    this.writing = this.writing.then(async () => {
      const temporary = `${this.file}.saving`;
      await writeFile(temporary, bytes);
      await rename(temporary, this.file);
    });
    return this.writing;
  }

  /** A copy of the whole production, as it is now, at another path. */
  async saveCopy(path: string): Promise<void> {
    await writeFile(path, this.db.export());
  }

  async close(): Promise<void> {
    await this.flush();
    this.db.close();
  }

  // ------------------------------------------------ production

  production(): Production {
    const row = this.rows<Record<string, string | number>>('select * from production where id = 1')[0]!;
    return {
      name: String(row['name']),
      code: String(row['code']),
      frameRate: String(row['frame_rate']),
      checksum: row['checksum'] as ChecksumMethod,
      totalDays: Number(row['total_days']),
      devices: JSON.parse(String(row['devices'])) as Production['devices'],
      namingTokens: JSON.parse(String(row['naming_tokens'])) as string[],
    };
  }

  updateProduction(patch: Partial<Production>) {
    const next = { ...this.production(), ...patch };
    this.transaction(() =>
      this.run(
        'update production set name = ?, code = ?, frame_rate = ?, checksum = ?, total_days = ?, devices = ?, naming_tokens = ?, updated_at = ? where id = 1',
        [next.name, next.code, next.frameRate, next.checksum, next.totalDays, JSON.stringify(next.devices), JSON.stringify(next.namingTokens), now()],
      ),
    );
  }

  // ------------------------------------------------ shoot days

  private static day(row: Record<string, SqlValue>): ShootDay {
    return {
      number: Number(row['number']),
      date: String(row['date']),
      locations: String(row['locations']),
      operator: { name: String(row['operator_name']), initials: String(row['operator_initials']) },
    };
  }

  days(): ShootDay[] {
    return this.rows('select * from shoot_day order by number').map(ProductionDb.day);
  }

  currentDay(): ShootDay {
    const number = this.value<number>('select current_day from production where id = 1') ?? 1;
    const row = this.rows('select * from shoot_day where number = ?', [number])[0] ?? this.rows('select * from shoot_day order by number limit 1')[0]!;
    return ProductionDb.day(row);
  }

  /** The next day: numbered after the last one, dated today (or the day after the last, if that is later), and opened. */
  addDay(): ShootDay {
    const last = this.days().at(-1);
    const number = (last?.number ?? 0) + 1;
    let date = localDate();
    if (last && last.date >= date) {
      const following = new Date(`${last.date}T12:00:00`);
      following.setDate(following.getDate() + 1);
      date = localDate(following);
    }
    this.transaction(() => {
      this.run('insert into shoot_day (number, date, locations, operator_name, operator_initials, created_at) values (?, ?, ?, ?, ?, ?)', [
        number,
        date,
        '',
        last?.operator.name ?? '',
        last?.operator.initials ?? '',
        now(),
      ]);
      this.run('update production set current_day = ? where id = 1', [number]);
    });
    return this.currentDay();
  }

  openDay(number: number) {
    if (!this.days().some((day) => day.number === number)) throw new Error('No such shoot day.');
    this.transaction(() => this.run('update production set current_day = ? where id = 1', [number]));
  }

  updateDay(number: number, patch: Partial<Omit<ShootDay, 'number'>>) {
    const day = this.days().find((candidate) => candidate.number === number);
    if (!day) throw new Error('No such shoot day.');
    const next = { ...day, ...patch, operator: { ...day.operator, ...patch.operator } };
    this.transaction(() =>
      this.run('update shoot_day set date = ?, locations = ?, operator_name = ?, operator_initials = ? where number = ?', [
        next.date,
        next.locations,
        next.operator.name,
        next.operator.initials,
        number,
      ]),
    );
  }

  // ------------------------------------------------ scenes

  scenes(day: number): SceneEntry[] {
    return this.rows<Record<string, string>>('select * from scene where day = ? order by position', [day]).map((row) => ({
      id: row['id']!,
      description: row['description']!,
      status: row['status'] as SceneStatus,
      notes: row['notes']!,
      look: row['look']!,
    }));
  }

  addScene(day: number, scene: Pick<SceneEntry, 'id'> & Partial<SceneEntry>): boolean {
    const id = scene.id.trim().toUpperCase();
    if (!id || this.scenes(day).some((existing) => existing.id === id)) return false;
    const position = (this.value<number>('select max(position) from scene where day = ?', [day]) ?? 0) + 1;
    this.transaction(() =>
      this.run('insert into scene (day, id, description, status, notes, look, position) values (?, ?, ?, ?, ?, ?, ?)', [
        day,
        id,
        scene.description?.trim() ?? '',
        scene.status ?? 'Scheduled',
        scene.notes ?? '',
        scene.look ?? '',
        position,
      ]),
    );
    return true;
  }

  updateScene(day: number, id: string, patch: Partial<Omit<SceneEntry, 'id'>>) {
    const scene = this.scenes(day).find((candidate) => candidate.id === id);
    if (!scene) throw new Error('No such scene.');
    const next = { ...scene, ...patch };
    this.transaction(() =>
      this.run('update scene set description = ?, status = ?, notes = ?, look = ? where day = ? and id = ?', [next.description, next.status, next.notes, next.look, day, id]),
    );
  }

  removeScene(day: number, id: string) {
    this.transaction(() => this.run('delete from scene where day = ? and id = ?', [day, id]));
  }

  // ------------------------------------------------ transfers and clips

  /** Keep a transfer as it stands now; called again as it progresses, it replaces what was kept. */
  saveTransfer(record: TransferRecord) {
    this.transaction(() => {
      const key = [record.day, record.id];
      this.run('delete from clip_copy where clip_id in (select id from clip where day = ? and transfer_id = ?)', key);
      this.run('delete from clip where day = ? and transfer_id = ?', key);
      this.run('delete from transfer_destination where day = ? and transfer_id = ?', key);
      this.run('delete from transfer where day = ? and id = ?', key);
      this.run('insert into transfer (id, day, card, label, source_root, sound, checksum, started_at, finished_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        record.id,
        record.day,
        record.card,
        record.label,
        record.sourceRoot,
        record.sound ? 1 : 0,
        record.checksum,
        record.startedAt,
        record.finishedAt,
      ]);
      for (const [position, destination] of record.destinations.entries()) {
        this.run(
          'insert into transfer_destination (day, transfer_id, leg_id, position, name, root, target_dir, reports_dir, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [record.day, record.id, destination.id, position, destination.name, destination.root, destination.targetDir, destination.reportsDir, destination.error],
        );
      }
      const insertClip = this.db.prepare(
        `insert into clip (day, transfer_id, card, path, file_name, kind, size, mtime_ms, checksum_method, checksum, hashed_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      );
      const insertCopy = this.db.prepare('insert into clip_copy (clip_id, leg_id, state, error) values (?, ?, ?, ?)');
      try {
        for (const file of record.files) {
          insertClip.bind([
            record.day,
            record.id,
            record.card,
            file.path,
            file.path.split('/').pop()!,
            record.sound ? 'sound' : 'camera',
            file.size,
            file.mtimeMs,
            record.checksum,
            file.hash,
            file.hashedAt,
          ]);
          insertClip.step();
          const clipId = insertClip.get()[0] as number;
          insertClip.reset();
          for (const destination of record.destinations) {
            const outcome = destination.outcomes[file.path];
            if (!outcome) continue;
            insertCopy.run([clipId, destination.id, outcome.state, outcome.error ?? null]);
          }
        }
      } finally {
        insertClip.free();
        insertCopy.free();
      }
    });
  }

  transfers(day: number): TransferRecord[] {
    const transfers = this.rows<Record<string, SqlValue>>('select * from transfer where day = ? order by started_at, id', [day]);
    return transfers.map((row) => {
      const id = String(row['id']);
      const destinations = this.rows<Record<string, SqlValue>>('select * from transfer_destination where day = ? and transfer_id = ? order by position', [day, id]).map(
        (leg) => ({
          id: String(leg['leg_id']),
          name: String(leg['name']),
          root: String(leg['root']),
          targetDir: String(leg['target_dir']),
          reportsDir: String(leg['reports_dir']),
          error: (leg['error'] as string | null) ?? null,
          outcomes: {} as Record<string, FileOutcome>,
        }),
      );
      const clips = this.rows<Record<string, SqlValue>>('select * from clip where day = ? and transfer_id = ? order by id', [day, id]);
      const byLeg = new Map(destinations.map((destination) => [destination.id, destination]));
      for (const copy of this.rows<Record<string, SqlValue>>(
        'select c.path, cc.leg_id, cc.state, cc.error from clip_copy cc join clip c on c.id = cc.clip_id where c.day = ? and c.transfer_id = ?',
        [day, id],
      )) {
        const outcome: FileOutcome = { state: copy['state'] as FileOutcome['state'] };
        if (copy['error']) outcome.error = String(copy['error']);
        const destination = byLeg.get(String(copy['leg_id']));
        if (destination) destination.outcomes[String(copy['path'])] = outcome;
      }
      return {
        id,
        day,
        card: String(row['card']),
        label: String(row['label']),
        sourceRoot: String(row['source_root']),
        sound: Number(row['sound']) === 1,
        checksum: row['checksum'] as ChecksumMethod,
        startedAt: (row['started_at'] as string | null) ?? null,
        finishedAt: (row['finished_at'] as string | null) ?? null,
        files: clips.map((clip) => ({
          path: String(clip['path']),
          size: Number(clip['size']),
          mtimeMs: Number(clip['mtime_ms']),
          hash: (clip['checksum'] as string | null) ?? null,
          hashedAt: (clip['hashed_at'] as string | null) ?? null,
        })),
        destinations,
      };
    });
  }

  /** Clips found by name across the whole production, newest day first: the start of the media index. */
  findClips(fileName: string): { day: number; card: string; path: string; checksum: string | null; verifiedCopies: number }[] {
    return this.rows<Record<string, SqlValue>>(
      `select c.day, c.card, c.path, c.checksum,
              (select count(*) from clip_copy cc where cc.clip_id = c.id and cc.state != 'failed') as verified
       from clip c where c.file_name = ? order by c.day desc, c.id`,
      [fileName],
    ).map((row) => ({
      day: Number(row['day']),
      card: String(row['card']),
      path: String(row['path']),
      checksum: (row['checksum'] as string | null) ?? null,
      verifiedCopies: Number(row['verified']),
    }));
  }
}
