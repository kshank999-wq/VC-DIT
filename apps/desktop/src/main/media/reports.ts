import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { MHL_HASH_ELEMENT } from './checksum';
import type { LegPlan, TransferResult } from './transfer';

/**
 * The records a transfer leaves behind (spec §4.3, §8 "every transfer is
 * auditable"), on every destination:
 *
 * - An ASC MHL v2.0 generation in the card's folder (`ascmhl/`), listing
 *   each verified file with its checksum, plus the chain file that seals it.
 *   It is what post houses check a delivery against.
 * - A CSV and a JSON transfer log in the day's REPORTS/ingest_verification/
 *   folder: every file, every destination, verified or why not.
 */

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** ISO 8601 with an explicit offset, as ASC MHL writes dates. */
const mhlDate = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, '+00:00');

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** The C4 ID (SMPTE ST 2114) of some bytes: "c4" and the SHA-512 in base58, 90 characters. */
export const c4id = (bytes: Uint8Array | string): string => {
  let value = BigInt(`0x${createHash('sha512').update(bytes).digest('hex')}`);
  let digits = '';
  while (value > 0n) {
    digits = BASE58[Number(value % 58n)]! + digits;
    value /= 58n;
  }
  return `c4${digits.padStart(88, '1')}`;
};

export interface ReportContext {
  card: string;
  tool: { name: string; version: string };
  /** Where the CSV and JSON logs go on this destination. */
  reportsDir: string;
}

const stamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').replace('T', '_');

/** The next generation in the card folder's ASC MHL history, and the chain so far. */
const nextGeneration = async (dir: string): Promise<{ number: number; chain: string }> => {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    // No history yet.
  }
  const numbers = names.map((name) => /^(\d{4})_.*\.mhl$/.exec(name)?.[1]).filter((n): n is string => Boolean(n)).map(Number);
  let chain = '';
  try {
    chain = await readFile(join(dir, 'ascmhl_chain.xml'), 'utf8');
  } catch {
    // Starts with this generation.
  }
  return { number: numbers.length ? Math.max(...numbers) + 1 : 1, chain };
};

export const mhlHashList = (result: TransferResult, leg: LegPlan, context: ReportContext, now: Date): string | null => {
  const element = MHL_HASH_ELEMENT[result.method];
  const rows = result.files.filter((file) => {
    const outcome = file.legs[leg.id];
    return file.sourceHash && (outcome?.state === 'verified' || outcome?.state === 'already-there');
  });
  if (rows.length === 0) return null;
  const hashes = rows
    .map((file) => {
      const action = file.legs[leg.id]!.state === 'verified' ? 'original' : 'verified';
      return [
        '    <hash>',
        `      <path size="${file.size}" lastmodificationdate="${mhlDate(new Date(file.mtimeMs))}">${xml(file.path)}</path>`,
        `      <${element} action="${action}" hashdate="${mhlDate(new Date(file.hashedAt ?? now))}">${file.sourceHash}</${element}>`,
        '    </hash>',
      ].join('\n');
    })
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<hashlist version="2.0" xmlns="urn:ASC:MHL:v2.0">',
    '  <creatorinfo>',
    `    <creationdate>${mhlDate(now)}</creationdate>`,
    `    <hostname>${xml(hostname())}</hostname>`,
    `    <tool version="${xml(context.tool.version)}">${xml(context.tool.name)}</tool>`,
    '  </creatorinfo>',
    '  <processinfo>',
    '    <process>transfer</process>',
    '    <ignore>',
    ...['.DS_Store', 'ascmhl', 'ascmhl/', '._*', '*.vcdit-part'].map((pattern) => `      <pattern>${xml(pattern)}</pattern>`),
    '    </ignore>',
    '  </processinfo>',
    '  <hashes>',
    hashes,
    '  </hashes>',
    '</hashlist>',
    '',
  ].join('\n');
};

const writeMhl = async (result: TransferResult, leg: LegPlan, context: ReportContext, now: Date): Promise<string | null> => {
  const body = mhlHashList(result, leg, context, now);
  if (!body) return null;
  const dir = join(leg.targetDir, 'ascmhl');
  await mkdir(dir, { recursive: true });
  const { number, chain } = await nextGeneration(dir);
  const name = `${String(number).padStart(4, '0')}_${context.card.replace(/[^\w.-]+/g, '_')}_${stamp(now)}.mhl`;
  await writeFile(join(dir, name), body, 'utf8');
  const entry = [`  <hashlist sequencenr="${number}">`, `    <path>${xml(name)}</path>`, `    <c4>${c4id(body)}</c4>`, '  </hashlist>'].join('\n');
  const previous = /<ascmhldirectory[^>]*>([\s\S]*)<\/ascmhldirectory>/.exec(chain)?.[1]?.replace(/^\n+|\s+$/g, '');
  const directory = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ascmhldirectory xmlns="urn:ASC:MHL:DIRECTORY:v2.0">',
    ...(previous ? [previous] : []),
    entry,
    '</ascmhldirectory>',
    '',
  ].join('\n');
  await writeFile(join(dir, 'ascmhl_chain.xml'), directory, 'utf8');
  return join(dir, name);
};

const csvCell = (value: string | number) => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** One row per file per destination. */
export const transferCsv = (result: TransferResult, legs: LegPlan[]): string => {
  const header = ['file', 'size_bytes', 'checksum_method', 'card_checksum', 'destination', 'result', 'detail'];
  const rows = result.files.flatMap((file) =>
    legs.map((leg) => {
      const outcome = file.legs[leg.id];
      return [file.path, file.size, result.method, file.sourceHash ?? '', leg.name, outcome?.state ?? 'failed', outcome?.error ?? ''];
    }),
  );
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
};

export interface WrittenReports {
  legId: string;
  mhl: string | null;
  csv: string | null;
  error: string | null;
}

/** Write each destination's records. A destination that cannot take them is noted; its verified files stay verified. */
export const writeReports = async (
  result: TransferResult,
  legs: LegPlan[],
  contexts: Record<string, ReportContext>,
  all: LegPlan[] = legs,
): Promise<WrittenReports[]> => {
  const now = new Date(result.finishedAt);
  const csv = transferCsv(result, all);
  const json = JSON.stringify({ ...result, destinations: all.map(({ id, name, targetDir }) => ({ id, name, targetDir })) }, null, 2);
  return Promise.all(
    legs.map(async (leg) => {
      const context = contexts[leg.id]!;
      if (result.legs[leg.id]?.error) return { legId: leg.id, mhl: null, csv: null, error: result.legs[leg.id]!.error };
      try {
        // The destination itself must still be there: never recreate a vanished mount point's path.
        await stat(leg.root);
        const mhl = await writeMhl(result, leg, context, now);
        await mkdir(context.reportsDir, { recursive: true });
        const base = join(context.reportsDir, `${context.card.replace(/[^\w.-]+/g, '_')}_${stamp(now)}`);
        await writeFile(`${base}.csv`, csv, 'utf8');
        await writeFile(`${base}.json`, json, 'utf8');
        return { legId: leg.id, mhl, csv: `${base}.csv`, error: null };
      } catch (cause) {
        return { legId: leg.id, mhl: null, csv: null, error: cause instanceof Error ? cause.message : String(cause) };
      }
    }),
  );
};
