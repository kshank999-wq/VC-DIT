import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import type { ChecksumMethod } from '../../shared/media';
import {
  DEFAULT_NAMING,
  MIRROR_METHODS,
  localDate,
  type MirrorMethod,
  type Production,
  type ProjectState,
  type SceneEntry,
  type SceneStatus,
  type ShootDay,
  type VfxEntry,
  type VfxLocation,
} from '../../shared/project';
import type { FileOutcome, SourceFile } from '../media/transfer';
import { matchDay, type Candidate, type DayClip } from '../scriptlog/match';
import type { LogEntry, ParsedLog } from '../scriptlog/parse';
import { clipKeyOfFile } from '../scriptlog/clip-key';
import { buildLogView, candidateLabel, type StoredEntry, type StoredImport, type StoredMatch, type VfxFlag } from '../scriptlog/view';
import type { MirrorFile, MirrorOutcome, MirrorPlan } from '../vfx/mirror';

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
  `
  -- The day's script supervisor log (spec §4.5): the last file imported,
  -- its rows, and how each row's clips were matched.
  create table script_import (
    day integer primary key,
    file_name text not null,
    format text not null,
    imported_at text not null,
    warnings text not null default '[]'
  );

  create table script_entry (
    id integer primary key,
    day integer not null,
    position integer not null,
    scene text not null,
    setup text not null,
    take text not null,
    slate text not null,
    cameras text not null,
    clip_refs text not null,
    roll text not null,
    sound_roll text not null,
    sound_ref text not null,
    tc_in text not null,
    tc_out text not null,
    circle integer not null,
    print integer not null,
    vfx integer not null,
    vfx_note text not null,
    notes text not null,
    lens text not null,
    description text not null
  );
  create index script_entry_day_idx on script_entry (day, position);

  -- One row per camera clip a log row names (or per camera, when it names none).
  create table script_match (
    entry_id integer not null,
    ref_index integer not null,
    ref text not null,
    camera text not null,
    state text not null check (state in ('matched', 'review', 'unmatched')),
    clip_key text,
    clip_card text,
    candidates text not null default '[]',
    reason text not null default '',
    decided text not null default 'auto' check (decided in ('auto', 'dit', 'wild')),
    primary key (entry_id, ref_index)
  );

  create table script_sound (
    entry_id integer primary key,
    clip_key text not null,
    clip_card text not null
  );

  -- The DIT's decisions, kept by what the row says rather than by row, so
  -- they survive importing an updated log; a corrected row is decided afresh.
  create table script_decision (
    day integer not null,
    entry_key text not null,
    ref_index integer not null,
    clip_key text,
    clip_card text,
    primary key (day, entry_key, ref_index)
  );
  `,
];

const MIGRATION_3 = `
  -- VFX (spec §4.9): how shots are mirrored, shots the DIT tagged, each
  -- destination's mirror of each shot, and what was handed to VC VFX Prep.
  alter table production add column vfx_method text not null default 'Hard link';

  create table vfx_tag (
    day integer not null,
    scene text not null,
    setup text not null,
    take text not null,
    clip_key text not null,
    card text not null,
    note text not null default '',
    created_at text not null,
    primary key (day, card, clip_key)
  );

  create table vfx_mirror (
    day integer not null,
    shot_key text not null,
    leg_id text not null,
    destination text not null,
    method text not null,
    target_dir text not null,
    state text not null check (state in ('mirrored', 'failed')),
    error text,
    made_at text not null,
    primary key (day, shot_key, leg_id)
  );

  create table vfx_handoff (
    day integer not null,
    shot_key text not null,
    sent_at text not null,
    package text not null,
    primary key (day, shot_key)
  );
`;
// Kept beside the code that reads it; appended, so the order of versions never changes.
MIGRATIONS.push(MIGRATION_3);

/** A VFX shot's key: the take and the clip on its card. */
const shotKey = (shot: { scene: string; setup: string; take: string; card: string | null; clip: string }) =>
  [shot.scene, shot.setup, shot.take, shot.card ?? '-', shot.clip].join('|');

/** One destination's verified copy of a clip. */
interface ClipLocation {
  legId: string;
  name: string;
  root: string;
  cardDir: string;
  files: MirrorFile[];
  checksum: ChecksumMethod;
}

/** What a log row says, as a key for the DIT's decision about it. */
const entryKey = (entry: LogEntry) =>
  [entry.scene, entry.setup, entry.take, entry.cameras.join(','), entry.clipRefs.join(','), entry.roll, entry.tcIn].join('|');

let sql: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null;
const engine = (wasm: string) =>
  (sql ??= readFile(wasm).then((binary) =>
    initSqlJs({ wasmBinary: binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer }),
  ));

const now = () => new Date().toISOString();

export const DEFAULT_PRODUCTION: Production = {
  name: 'Untitled production',
  code: 'PROD',
  frameRate: '23.976 fps',
  checksum: 'xxHash64',
  totalDays: 30,
  devices: [],
  namingTokens: DEFAULT_NAMING,
  vfxMethod: 'Hard link',
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
    return version === 0
      ? this.rows('select name from sqlite_master').length === 0
      : this.rows("select 1 from sqlite_master where name = 'production'").length > 0;
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
        [
          production.name,
          production.code,
          production.frameRate,
          production.checksum,
          production.totalDays,
          JSON.stringify(production.devices),
          JSON.stringify(production.namingTokens),
          at,
          at,
        ],
      );
      this.run('update production set vfx_method = ? where id = 1', [production.vfxMethod]);
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
      vfxMethod: MIRROR_METHODS.includes(row['vfx_method'] as MirrorMethod) ? (row['vfx_method'] as MirrorMethod) : 'Hard link',
    };
  }

  updateProduction(patch: Partial<Production>) {
    const next = { ...this.production(), ...patch };
    this.transaction(() =>
      this.run(
        'update production set name = ?, code = ?, frame_rate = ?, checksum = ?, total_days = ?, devices = ?, naming_tokens = ?, vfx_method = ?, updated_at = ? where id = 1',
        [
          next.name,
          next.code,
          next.frameRate,
          next.checksum,
          next.totalDays,
          JSON.stringify(next.devices),
          JSON.stringify(next.namingTokens),
          next.vfxMethod,
          now(),
        ],
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
      this.run('update scene set description = ?, status = ?, notes = ?, look = ? where day = ? and id = ?', [
        next.description,
        next.status,
        next.notes,
        next.look,
        day,
        id,
      ]),
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
          [
            record.day,
            record.id,
            destination.id,
            position,
            destination.name,
            destination.root,
            destination.targetDir,
            destination.reportsDir,
            destination.error,
          ],
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
      const destinations = this.rows<Record<string, SqlValue>>('select * from transfer_destination where day = ? and transfer_id = ? order by position', [
        day,
        id,
      ]).map((leg) => ({
        id: String(leg['leg_id']),
        name: String(leg['name']),
        root: String(leg['root']),
        targetDir: String(leg['target_dir']),
        reportsDir: String(leg['reports_dir']),
        error: (leg['error'] as string | null) ?? null,
        outcomes: {} as Record<string, FileOutcome>,
      }));
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

  // ------------------------------------------------ the script supervisor's log

  /**
   * Replace the day's log with a newly imported one. Scenes it names that are
   * not on the day's list are added (as shot); then every row is matched.
   */
  importLog(day: number, fileName: string, parsed: ParsedLog): void {
    const listed = this.scenes(day);
    const ids = new Set(listed.map((scene) => scene.id));
    // "12A" is scene 12A when the list has it (and no scene 12), else scene 12, setup A.
    const entries = parsed.entries.map((entry) =>
      entry.setup && ids.has(entry.slate) && !ids.has(entry.scene) ? { ...entry, scene: entry.slate, setup: '' } : entry,
    );
    this.transaction(() => {
      this.clearLogRows(day);
      for (const [position, entry] of entries.entries()) {
        this.run(
          `insert into script_entry (day, position, scene, setup, take, slate, cameras, clip_refs, roll, sound_roll, sound_ref, tc_in, tc_out,
             circle, print, vfx, vfx_note, notes, lens, description)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            day,
            position,
            entry.scene,
            entry.setup,
            entry.take,
            entry.slate,
            JSON.stringify(entry.cameras),
            JSON.stringify(entry.clipRefs),
            entry.roll,
            entry.soundRoll,
            entry.soundRef,
            entry.tcIn,
            entry.tcOut,
            entry.circle ? 1 : 0,
            entry.print ? 1 : 0,
            entry.vfx ? 1 : 0,
            entry.vfxNote,
            entry.notes,
            entry.lens,
            entry.description,
          ],
        );
      }
      this.run('insert or replace into script_import (day, file_name, format, imported_at, warnings) values (?, ?, ?, ?, ?)', [
        day,
        fileName,
        parsed.format,
        now(),
        JSON.stringify(parsed.warnings.slice(0, 200)),
      ]);
      // Scenes the log names that the day's list does not have yet.
      let position = this.value<number>('select max(position) from scene where day = ?', [day]) ?? 0;
      for (const entry of entries) {
        if (ids.has(entry.scene)) continue;
        ids.add(entry.scene);
        position += 1;
        this.run("insert into scene (day, id, description, status, notes, look, position) values (?, ?, ?, 'Shot', '', '', ?)", [
          day,
          entry.scene,
          entry.description,
          position,
        ]);
      }
    });
    this.rematch(day);
  }

  private clearLogRows(day: number) {
    this.run('delete from script_match where entry_id in (select id from script_entry where day = ?)', [day]);
    this.run('delete from script_sound where entry_id in (select id from script_entry where day = ?)', [day]);
    this.run('delete from script_entry where day = ?', [day]);
  }

  private logEntries(day: number): StoredEntry[] {
    return this.rows<Record<string, SqlValue>>('select * from script_entry where day = ? order by position', [day]).map((row) => ({
      id: Number(row['id']),
      line: Number(row['position']) + 1,
      scene: String(row['scene']),
      setup: String(row['setup']),
      take: String(row['take']),
      slate: String(row['slate']),
      cameras: JSON.parse(String(row['cameras'])) as string[],
      clipRefs: JSON.parse(String(row['clip_refs'])) as string[],
      roll: String(row['roll']),
      soundRoll: String(row['sound_roll']),
      soundRef: String(row['sound_ref']),
      tcIn: String(row['tc_in']),
      tcOut: String(row['tc_out']),
      circle: Number(row['circle']) === 1,
      print: Number(row['print']) === 1,
      vfx: Number(row['vfx']) === 1,
      vfxNote: String(row['vfx_note']),
      notes: String(row['notes']),
      lens: String(row['lens']),
      description: String(row['description']),
    }));
  }

  /** Match the day's log against the day's clips again: after an import, and whenever another card comes in. */
  rematch(day: number): void {
    const entries = this.logEntries(day);
    if (entries.length === 0) return;
    const clips = this.rows<Record<string, SqlValue>>('select card, path, file_name, kind, size, mtime_ms from clip where day = ?', [day]).map<DayClip>(
      (row) => ({
        card: String(row['card']),
        path: String(row['path']),
        fileName: String(row['file_name']),
        kind: row['kind'] as DayClip['kind'],
        size: Number(row['size']),
        mtimeMs: Number(row['mtime_ms']),
      }),
    );
    const results = matchDay(entries, clips);
    const decisions = new Map(
      this.rows<Record<string, SqlValue>>('select * from script_decision where day = ?', [day]).map((row) => [
        `${String(row['entry_key'])}#${Number(row['ref_index'])}`,
        { key: (row['clip_key'] as string | null) ?? null, card: (row['clip_card'] as string | null) ?? null },
      ]),
    );
    this.transaction(() => {
      this.run('delete from script_match where entry_id in (select id from script_entry where day = ?)', [day]);
      this.run('delete from script_sound where entry_id in (select id from script_entry where day = ?)', [day]);
      for (const entry of entries) {
        const result = results.get(entry)!;
        for (const [index, ref] of result.camera.entries()) {
          const decision = decisions.get(`${entryKey(entry)}#${index}`);
          const decided = decision ? (decision.key ? 'dit' : 'wild') : 'auto';
          this.run(
            `insert into script_match (entry_id, ref_index, ref, camera, state, clip_key, clip_card, candidates, reason, decided)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              entry.id,
              index,
              ref.ref,
              ref.camera,
              decision ? 'matched' : ref.state,
              decision ? decision.key : (ref.clip?.key ?? null),
              decision ? decision.card : (ref.clip?.card ?? null),
              // A decided clip stays among the candidates, so the screen can show what was picked.
              JSON.stringify(
                decision?.key && !ref.candidates.some((candidate) => candidate.key === decision.key && candidate.card === decision.card)
                  ? [...ref.candidates, { key: decision.key, card: decision.card ?? '', tc: '—', confidence: 0, why: 'Picked by the DIT' }]
                  : ref.candidates,
              ),
              ref.reason,
              decided,
            ],
          );
        }
        if (result.sound)
          this.run('insert into script_sound (entry_id, clip_key, clip_card) values (?, ?, ?)', [entry.id, result.sound.key, result.sound.card]);
      }
    });
  }

  /** The DIT's decision on one row's clip: a candidate (by the label the screen showed), or none at all (wild, MOS, no camera). */
  resolveMatch(day: number, id: string, label: string | null): void {
    const [entryId, refIndex] = id.split(':').map(Number) as [number, number];
    const entry = this.logEntries(day).find((candidate) => candidate.id === entryId);
    const row = this.rows<Record<string, SqlValue>>('select candidates from script_match where entry_id = ? and ref_index = ?', [entryId, refIndex])[0];
    if (!entry || !row) throw new Error('That log entry is no longer in the log.');
    let clip: Candidate | null = null;
    if (label !== null) {
      const candidates = JSON.parse(String(row['candidates'])) as Candidate[];
      clip = candidates.find((candidate) => candidateLabel(candidate, candidates) === label) ?? null;
      if (!clip) throw new Error('That clip is not one of the candidates.');
    }
    this.transaction(() => {
      this.run('insert or replace into script_decision (day, entry_key, ref_index, clip_key, clip_card) values (?, ?, ?, ?, ?)', [
        day,
        entryKey(entry),
        refIndex,
        clip?.key ?? null,
        clip?.card ?? null,
      ]);
      this.run("update script_match set state = 'matched', clip_key = ?, clip_card = ?, decided = ? where entry_id = ? and ref_index = ?", [
        clip?.key ?? null,
        clip?.card ?? null,
        clip ? 'dit' : 'wild',
        entryId,
        refIndex,
      ]);
    });
  }

  /** The day's scenes with their setups and takes, the entries to review, the VFX flags and the import's numbers. */
  logView(day: number): Pick<ProjectState, 'scenes' | 'log' | 'matches' | 'vfx'> {
    const entries = this.logEntries(day);
    const ids = new Set(entries.map((entry) => entry.id));
    const matches = this.rows<Record<string, SqlValue>>(
      'select m.* from script_match m join script_entry e on e.id = m.entry_id where e.day = ? order by e.position, m.ref_index',
      [day],
    ).map<StoredMatch>((row) => ({
      entryId: Number(row['entry_id']),
      refIndex: Number(row['ref_index']),
      ref: String(row['ref']),
      camera: String(row['camera']),
      state: row['state'] as StoredMatch['state'],
      clipKey: (row['clip_key'] as string | null) ?? null,
      clipCard: (row['clip_card'] as string | null) ?? null,
      candidates: JSON.parse(String(row['candidates'])) as Candidate[],
      reason: String(row['reason']),
      decided: row['decided'] as StoredMatch['decided'],
    }));
    const sounds = new Map(
      this.rows<Record<string, SqlValue>>('select entry_id, clip_key from script_sound')
        .filter((row) => ids.has(Number(row['entry_id'])))
        .map((row) => [Number(row['entry_id']), String(row['clip_key'])]),
    );
    const imported = this.rows<Record<string, SqlValue>>('select * from script_import where day = ?', [day])[0];
    const log: StoredImport | null = imported
      ? {
          fileName: String(imported['file_name']),
          format: String(imported['format']),
          importedAt: String(imported['imported_at']),
          warnings: JSON.parse(String(imported['warnings'])) as string[],
        }
      : null;
    const view = buildLogView({ scenes: this.scenes(day), entries, matches, sounds, log, frameRate: this.production().frameRate });
    return { ...view, vfx: this.vfxShots(day, view.vfx).map(({ entry }) => entry) };
  }

  // ------------------------------------------------ VFX

  /** Where a clip's verified copies are: each destination that has every one of its files verified. */
  private clipLocations(day: number, card: string, clip: string): ClipLocation[] {
    const rows = this.rows<Record<string, SqlValue>>(
      'select id, path, file_name, size, mtime_ms, checksum, checksum_method from clip where day = ? and card = ? order by id',
      [day, card],
    ).filter((row) => {
      const name = String(row['file_name']);
      return (clipKeyOfFile(name) ?? name.replace(/\.[^.]+$/, '')) === clip;
    });
    if (rows.length === 0) return [];
    const files = new Map<string, MirrorFile>();
    for (const row of rows) {
      const path = String(row['path']);
      if (!files.has(path)) {
        files.set(path, { path, size: Number(row['size']), mtimeMs: Number(row['mtime_ms']), hash: (row['checksum'] as string | null) ?? null });
      }
    }
    const ids = rows.map((row) => Number(row['id']));
    const copies = this.rows<Record<string, SqlValue>>(
      `select c.path, cc.leg_id, td.name, td.root, td.target_dir
       from clip_copy cc
       join clip c on c.id = cc.clip_id
       join transfer_destination td on td.day = c.day and td.transfer_id = c.transfer_id and td.leg_id = cc.leg_id
       where cc.state != 'failed' and c.id in (${ids.map(() => '?').join(', ')})`,
      ids,
    );
    const legs = new Map<string, { name: string; root: string; cardDir: string; verified: Set<string> }>();
    for (const copy of copies) {
      const id = String(copy['leg_id']);
      const leg = legs.get(id) ?? { name: String(copy['name']), root: String(copy['root']), cardDir: String(copy['target_dir']), verified: new Set<string>() };
      leg.verified.add(String(copy['path']));
      legs.set(id, leg);
    }
    const checksum = rows[0]!['checksum_method'] as ChecksumMethod;
    return [...legs]
      .filter(([, leg]) => [...files.keys()].every((path) => leg.verified.has(path)))
      .map(([legId, leg]) => ({ legId, name: leg.name, root: leg.root, cardDir: leg.cardDir, files: [...files.values()], checksum }));
  }

  /** The day's VFX shots: the log's flags and the DIT's tags, each with where it is and how it is mirrored. */
  private vfxShots(day: number, flags: VfxFlag[]): { entry: VfxEntry; flag: VfxFlag; locations: ClipLocation[] }[] {
    const tags = this.rows<Record<string, SqlValue>>('select * from vfx_tag where day = ? order by created_at', [day]).map<VfxFlag & { tagged: true }>((row) => ({
      scene: String(row['scene']),
      setup: String(row['setup']),
      take: String(row['take']),
      clip: String(row['clip_key']),
      card: String(row['card']),
      note: String(row['note']),
      matched: true,
      tagged: true,
    }));
    const mirrors = new Map(
      this.rows<Record<string, SqlValue>>('select * from vfx_mirror where day = ?', [day]).map((row) => [`${String(row['shot_key'])}#${String(row['leg_id'])}`, row]),
    );
    const sent = new Map(this.rows<Record<string, SqlValue>>('select shot_key, sent_at from vfx_handoff where day = ?', [day]).map((row) => [String(row['shot_key']), String(row['sent_at'])]));
    const all: (VfxFlag & { tagged?: true })[] = [...flags, ...tags.filter((tag) => !flags.some((flag) => flag.card === tag.card && flag.clip === tag.clip))];
    return all.map((flag) => {
      const key = shotKey(flag);
      const locations = flag.card ? this.clipLocations(day, flag.card, flag.clip) : [];
      const media = (location: ClipLocation) => location.files.find((file) => !/\.(xml|txt|ale|csv|json)$/i.test(file.path)) ?? location.files[0]!;
      const placed: VfxLocation[] = locations.map((location) => {
        const mirror = mirrors.get(`${key}#${location.legId}`);
        return {
          destination: location.name,
          editorial: join(location.cardDir, ...media(location).path.split('/').slice(0, -1)),
          mirror: mirror ? String(mirror['target_dir']) : null,
          method: mirror ? (String(mirror['method']) as MirrorMethod) : null,
          state: mirror ? (String(mirror['state']) as 'mirrored' | 'failed') : 'pending',
          error: mirror ? ((mirror['error'] as string | null) ?? null) : null,
        };
      });
      return {
        flag,
        locations,
        entry: {
          key,
          scene: flag.scene,
          setup: flag.setup,
          take: flag.take,
          clip: flag.clip,
          note: flag.note,
          flaggedBy: flag.tagged ? 'DIT tag' : 'Script sup.',
          matched: flag.matched,
          locations: placed,
          sentAt: sent.get(key) ?? null,
        },
      };
    });
  }

  /** Mirrors still to make on the day, by the production's method: those never made, and (when asked) those that failed. */
  mirrorPlans(day: number, retryFailed: boolean): MirrorPlan[] {
    const production = this.production();
    const date = this.days().find((candidate) => candidate.number === day)?.date ?? localDate();
    return this.vfxShots(day, this.vfxFlags(day)).flatMap(({ entry, locations }) =>
      locations
        .filter((location, index) => entry.locations[index]!.state === 'pending' || (retryFailed && entry.locations[index]!.state === 'failed'))
        .map((location) => ({
          key: entry.key,
          scene: entry.scene,
          setup: entry.setup,
          take: entry.take,
          clip: entry.clip,
          method: production.vfxMethod,
          checksum: location.checksum,
          production: { name: production.name, code: production.code },
          day: { number: day, date },
          location: { legId: location.legId, name: location.name, root: location.root, cardDir: location.cardDir, files: location.files },
        })),
    );
  }

  saveMirror(day: number, key: string, outcome: MirrorOutcome) {
    this.transaction(() =>
      this.run(
        `insert or replace into vfx_mirror (day, shot_key, leg_id, destination, method, target_dir, state, error, made_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [day, key, outcome.legId, outcome.destination, outcome.method, outcome.targetDir, outcome.state, outcome.error, now()],
      ),
    );
  }

  /** Tag a clip of the day as a VFX shot (spec §4.9 "tag additional candidates"). */
  tagVfx(day: number, clip: string, note: string) {
    const key = clip.trim().toUpperCase();
    const matched = this.rows<Record<string, SqlValue>>(
      `select e.scene, e.setup, e.take, m.clip_card from script_match m join script_entry e on e.id = m.entry_id
       where e.day = ? and m.clip_key = ? and m.state = 'matched' and m.decided != 'wild' limit 1`,
      [day, key],
    )[0];
    const card = matched
      ? String(matched['clip_card'])
      : this.rows<Record<string, SqlValue>>('select card, file_name from clip where day = ?', [day]).find(
          (row) => (clipKeyOfFile(String(row['file_name'])) ?? String(row['file_name']).replace(/\.[^.]+$/, '')) === key,
        )?.['card'];
    if (!card) throw new Error(`No clip named ${key} was ingested today.`);
    if (this.logView(day).vfx.some((shot) => shot.clip === key)) throw new Error(`${key} is already on the VFX list.`);
    this.transaction(() =>
      this.run('insert into vfx_tag (day, scene, setup, take, clip_key, card, note, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)', [
        day,
        matched ? String(matched['scene']) : '—',
        matched ? String(matched['setup']) || '—' : '—',
        matched ? String(matched['take']).padStart(2, '0') : '—',
        key,
        String(card),
        note.trim(),
        now(),
      ]),
    );
  }

  /** Shots ready for VC VFX Prep: known clip, mirrored somewhere, not sent yet. */
  handoffShots(day: number): { entry: VfxEntry; locations: ClipLocation[] }[] {
    return this.vfxShots(day, this.vfxFlags(day)).filter(
      ({ entry }) => entry.matched && !entry.sentAt && entry.locations.some((location) => location.state === 'mirrored'),
    );
  }

  markSent(day: number, keys: string[], packages: string[]) {
    const at = now();
    this.transaction(() => {
      for (const key of keys) this.run('insert or replace into vfx_handoff (day, shot_key, sent_at, package) values (?, ?, ?, ?)', [day, key, at, JSON.stringify(packages)]);
    });
  }

  /** The log's VFX flags for the day (no tags), for the VFX methods above. */
  vfxFlags(day: number): VfxFlag[] {
    const entries = this.logEntries(day);
    const matches = this.rows<Record<string, SqlValue>>(
      'select m.* from script_match m join script_entry e on e.id = m.entry_id where e.day = ? order by e.position, m.ref_index',
      [day],
    ).map<StoredMatch>((row) => ({
      entryId: Number(row['entry_id']),
      refIndex: Number(row['ref_index']),
      ref: String(row['ref']),
      camera: String(row['camera']),
      state: row['state'] as StoredMatch['state'],
      clipKey: (row['clip_key'] as string | null) ?? null,
      clipCard: (row['clip_card'] as string | null) ?? null,
      candidates: [],
      reason: '',
      decided: row['decided'] as StoredMatch['decided'],
    }));
    return buildLogView({ scenes: [], entries, matches, sounds: new Map(), log: null, frameRate: '24' }).vfx;
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
