import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * An in-memory stand-in for the Supabase client, covering the calls the
 * commerce path makes — with the unique constraints the real tables have, so
 * a test of idempotency tests the rule Postgres enforces.
 */

export type Row = Record<string, unknown> & { id: string };
export type Tables = Record<string, Row[]>;

const UNIQUE: Record<string, string[][]> = {
  dit_subscriptions: [['stripe_subscription_id']],
  dit_licenses: [['subscription_id'], ['serial']],
  dit_device_activations: [['license_id', 'device_fingerprint']],
  profiles: [['email']],
};

let sequence = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type Filter = (row: Row) => boolean;

class Query {
  private filters: Filter[] = [];
  private op: { kind: 'insert' | 'upsert' | 'update'; values: Record<string, unknown>; onConflict?: string } | null = null;
  private limitTo: number | null = null;

  constructor(private readonly tables: Tables, private readonly table: string, private readonly writes: string[]) {}

  private get rows(): Row[] {
    return (this.tables[this.table] ??= []);
  }

  select() {
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.limitTo = n;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  ilike(column: string, value: string) {
    this.filters.push((row) => String(row[column] ?? '').toLowerCase() === value.toLowerCase());
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  insert(values: Record<string, unknown>) {
    this.op = { kind: 'insert', values };
    return this;
  }
  upsert(values: Record<string, unknown>, options?: { onConflict?: string }) {
    this.op = { kind: 'upsert', values, onConflict: options?.onConflict };
    return this;
  }
  update(values: Record<string, unknown>) {
    this.op = { kind: 'update', values };
    return this;
  }

  private violates(candidate: Record<string, unknown>, except?: Row): string | null {
    for (const columns of UNIQUE[this.table] ?? []) {
      if (this.rows.some((row) => row !== except && columns.every((column) => row[column] === candidate[column]))) {
        return `duplicate key value violates unique constraint on ${this.table}(${columns.join(', ')})`;
      }
    }
    return null;
  }

  private run(): { data: Row[]; error: Error | null } {
    const matching = () => this.rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (!this.op) {
      const found = matching();
      return { data: clone(this.limitTo === null ? found : found.slice(0, this.limitTo)), error: null };
    }
    this.writes.push(`${this.op.kind} ${this.table}`);
    const { kind, values, onConflict } = this.op;
    if (kind === 'update') {
      const targets = matching();
      for (const target of targets) Object.assign(target, values);
      return { data: clone(targets), error: null };
    }
    if (kind === 'upsert' && onConflict) {
      const columns = onConflict.split(',');
      const existing = this.rows.find((row) => columns.every((column) => row[column] === values[column]));
      if (existing) {
        Object.assign(existing, values);
        return { data: clone([existing]), error: null };
      }
    }
    const violation = this.violates(values);
    if (violation) return { data: [], error: new Error(violation) };
    const row = { id: nextId(), ...values } as Row;
    this.rows.push(row);
    return { data: clone([row]), error: null };
  }

  async single() {
    const { data, error } = this.run();
    if (error) return { data: null, error };
    return data.length === 1 ? { data: data[0], error: null } : { data: null, error: new Error(`expected one row, got ${data.length}`) };
  }

  async maybeSingle() {
    const { data, error } = this.run();
    return { data: error ? null : data[0] ?? null, error };
  }

  then<A, B>(resolve: (value: { data: unknown; error: Error | null }) => A, reject?: (reason: unknown) => B): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(resolve, reject);
  }
}

export const fakeSupabase = (seed: Tables = {}) => {
  const tables: Tables = clone(seed);
  const writes: string[] = [];
  const authUsers: { id: string; email: string }[] = [];
  const client = {
    from: (table: string) => new Query(tables, table, writes),
    auth: {
      admin: {
        createUser: async ({ email }: { email: string }) => {
          if (authUsers.some((user) => user.email === email)) return { data: { user: null }, error: new Error('already registered') };
          const user = { id: nextId(), email };
          authUsers.push(user);
          // The signup trigger mirrors the email onto the profile.
          (tables['profiles'] ??= []).push({ id: user.id, email });
          return { data: { user }, error: null };
        },
      },
    },
  } as unknown as SupabaseClient;
  return { client, tables, writes, authUsers };
};
