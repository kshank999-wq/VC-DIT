import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { formatBytes } from '../../shared/media';
import type { OrganizeState, ReportEntry } from '../../shared/project';
import type { ProductionDb } from '../db/production-db';

/**
 * The day's reports (spec §8 "every transfer is auditable", §12.10): what
 * each step recorded, read from the production database, with the report
 * files it wrote on the drives. And the day report: all of it on a few
 * printable pages, for production and post.
 */

const plural = (count: number, word: string, many = `${word}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? word : many}`;
const latest = (times: (string | null | undefined)[]) => times.filter((time): time is string => Boolean(time)).sort().pop() ?? null;

const exists = async (path: string) => Boolean(await stat(path).catch(() => null));

/** Files in `dir` whose names start with `prefix`, newest last. */
const filesIn = async (dir: string, prefix = ''): Promise<string[]> => {
  try {
    return (await readdir(dir))
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
};

/** A day folder from any path inside it: the part before one of the day's own folders. */
const dayOf = (path: string, folder: string): string | null => {
  const at = path.replace(/\\/g, '/').lastIndexOf(`/${folder}/`);
  return at > 0 ? path.slice(0, at) : null;
};

export const dayEntries = async (db: ProductionDb, day: number, organize: OrganizeState): Promise<ReportEntry[]> => {
  const entries: ReportEntry[] = [];

  // ------------------------------------------------ ingest verification, card by card
  for (const transfer of db.transfers(day)) {
    const legs = transfer.destinations;
    const failed = legs.map((leg) => ({ leg, count: Object.values(leg.outcomes).filter((outcome) => outcome.state === 'failed').length }));
    const problems = failed.filter(({ leg, count }) => count > 0 || leg.error);
    const files: string[] = [];
    for (const leg of legs) {
      files.push(...(await filesIn(join(leg.targetDir, 'ascmhl'), '0')).slice(-1));
      files.push(...(await filesIn(leg.reportsDir, transfer.card.replace(/[^\w.-]+/g, '_'))).filter((path) => path.endsWith('.csv')).slice(-1));
    }
    const finished = Boolean(transfer.finishedAt);
    entries.push({
      id: `ingest:${transfer.id}`,
      step: 'verify',
      screen: 'verify',
      name: `Ingest verification — ${transfer.card}`,
      covers: problems.length
        ? problems.map(({ leg, count }) => (leg.error ? `${leg.name}: ${leg.error}` : `${plural(count, 'file')} failed on ${leg.name}`)).join(' · ')
        : `ASC MHL · ${plural(transfer.files.length, 'file')} · ${plural(legs.length, 'destination')} · ${transfer.checksum}`,
      time: transfer.finishedAt ?? transfer.startedAt,
      status: problems.length ? 'problem' : finished ? 'done' : 'working',
      word: problems.length ? 'Problem' : finished ? 'Safe to format' : 'In progress',
      card: transfer.card,
      files,
    });
  }

  // ------------------------------------------------ the script supervisor's log
  const view = db.logView(day);
  if (view.log) {
    const open = view.matches.filter((match) => match.resolution === null).length;
    entries.push({
      id: 'script',
      step: 'organize',
      screen: 'match',
      name: `Script supervisor log — ${view.log.file}`,
      covers: `${plural(view.log.entries, 'entry', 'entries')} · ${view.log.matched} matched · ${open} to review · ${view.log.vfxFlags} VFX`,
      time: null,
      status: open > 0 ? 'needs' : 'done',
      word: open > 0 ? 'Needs you' : 'Complete',
      files: [],
    });
  }

  // ------------------------------------------------ scene folders
  if (organize.placed + organize.failed + organize.pending > 0) {
    entries.push({
      id: 'scenes',
      step: 'organize',
      screen: 'scenes',
      name: 'Scene folders and selects',
      covers: `${plural(organize.placed, 'clip')} placed${organize.references ? ` · ${organize.references} as references` : ''}${organize.failed ? ` · ${organize.failed} not placed` : ''} · ${organize.folders.map((folder) => folder.destination).join(', ') || 'no drive yet'}`,
      time: null,
      status: organize.failed ? 'problem' : organize.pending ? 'working' : 'done',
      word: organize.failed ? 'Problem' : organize.pending ? 'In progress' : 'Complete',
      files: organize.folders.map((folder) => folder.path),
    });
  }

  // ------------------------------------------------ VFX
  if (view.vfx.length) {
    const locations = view.vfx.flatMap((shot) => shot.locations);
    const failed = locations.filter((location) => location.state === 'failed').length;
    const mirrored = view.vfx.filter((shot) => shot.locations.some((location) => location.state === 'mirrored')).length;
    const sent = view.vfx.filter((shot) => shot.sentAt).length;
    const mirrors = locations.map((location) => location.mirror).filter((path): path is string => Boolean(path));
    const vfxDir = mirrors[0] ? dayOf(mirrors[0], 'VFX') : null;
    entries.push({
      id: 'vfx',
      step: 'vfx',
      screen: 'vfx',
      name: 'VFX mirroring and handoff',
      covers: `${plural(view.vfx.length, 'shot')} · ${mirrored} mirrored · ${sent} sent to VC VFX Prep${failed ? ` · ${failed} failed` : ''}`,
      time: latest(view.vfx.map((shot) => shot.sentAt)),
      status: failed ? 'problem' : sent === view.vfx.length ? 'done' : 'needs',
      word: failed ? 'Problem' : sent === view.vfx.length ? 'Complete' : 'Needs you',
      files: vfxDir ? (await filesIn(join(vfxDir, 'VFX'), 'VC_VFX_PREP_')).filter((path) => path.endsWith('.json')).reverse() : [],
    });
  }

  // ------------------------------------------------ sync
  const sync = db.syncView(day);
  if (sync.length) {
    const none = sync.filter((item) => item.method === 'None').length;
    const open = sync.filter((item) => item.method !== 'None' && !item.accepted).length;
    const by = (method: string) => sync.filter((item) => item.method === method).length;
    entries.push({
      id: 'sync',
      step: 'sync',
      screen: 'sync',
      name: 'Picture and sound sync',
      covers: `${plural(sync.length, 'clip')} · ${by('Timecode')} timecode · ${by('Waveform')} waveform · ${by('Manual')} manual · ${none} no sound`,
      time: null,
      status: open ? 'needs' : none ? 'needs' : 'done',
      word: open ? `${open} to review` : none ? 'Some without sound' : 'Complete',
      files: [],
    });
  }

  // ------------------------------------------------ looks and dailies
  const luts = db.luts();
  const rules = db.lutRules(day);
  if (luts.length) {
    const fallback = luts.find((lut) => lut.isDefault);
    entries.push({
      id: 'looks',
      step: 'output',
      screen: 'looks',
      name: 'Looks',
      covers: `${plural(luts.length, 'LUT')} · ${plural(rules.length, 'rule')}${fallback ? ` · default ${fallback.name}` : ' · no project default'}`,
      time: latest(luts.map((lut) => lut.importedAt)),
      status: 'done',
      word: 'Recorded',
      files: [],
    });
  }
  const renders = db.renders(day);
  if (renders.length) {
    const failed = renders.filter((render) => render.state === 'failed').length;
    const done = renders.filter((render) => render.state === 'done');
    const dir = done[0] ? dayOf(done[0].output, 'SYNCED_DAILIES') : null;
    entries.push({
      id: 'dailies',
      step: 'output',
      screen: 'dailies',
      name: 'Dailies',
      covers: `${plural(done.length, 'daily', 'dailies')} · ${formatBytes(done.reduce((sum, render) => sum + (render.bytes ?? 0), 0))} · ${[...new Set(done.map((render) => render.codec))].join(', ')}${failed ? ` · ${failed} failed` : ''}`,
      time: null,
      status: failed ? 'problem' : 'done',
      word: failed ? 'Problem' : 'Complete',
      files: dir ? (await filesIn(join(dir, 'REPORTS', 'dailies'), 'DAILIES_')).reverse() : [],
    });
  }

  // ------------------------------------------------ delivery
  for (const record of db.deliveries(day)) {
    const files: string[] = [];
    if (record.mhl) {
      const targetDay = dirname(dirname(record.mhl));
      files.push(...(await filesIn(join(targetDay, 'REPORTS', 'delivery'), 'DELIVERY_MANIFEST_')).reverse().slice(0, 1), record.mhl);
    }
    entries.push({
      id: `delivery:${record.package}:${record.destinationId}`,
      step: 'output',
      screen: 'delivery',
      name: `Delivery — ${record.packageName} → ${record.destination}`,
      covers: `${plural(record.files, 'file')} · ${formatBytes(record.bytes)} from ${record.source}${record.failed ? ` · ${record.failed} not verified` : ''}${record.retries ? ` · ${plural(record.retries, 'retry', 'retries')}` : ''}`,
      time: record.finishedAt,
      status: record.failed ? 'problem' : 'done',
      word: record.failed ? 'Problem' : 'Verified',
      files,
    });
  }

  // Only files that are there now.
  for (const entry of entries) entry.files = (await Promise.all(entry.files.map(async (path) => ((await exists(path)) ? path : null)))).filter((path): path is string => Boolean(path));
  return entries;
};

// ------------------------------------------------ the day report

const html = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const table = (head: string[], rows: unknown[][], empty = 'Nothing recorded.') =>
  rows.length
    ? `<table><thead><tr>${head.map((cell) => `<th>${html(cell)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((row) => `<tr>${row.map((cell) => `<td>${html(cell)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    : `<p class="muted">${html(empty)}</p>`;

const clock = (iso: string | null | undefined) => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('en-GB', { hour12: false });
};

const WORD: Record<ReportEntry['status'], string> = { done: 'ok', needs: 'needs', problem: 'problem', working: 'working', idle: 'idle' };

/** The whole day on a few printable pages: what came in, where it went, what it is, and whether it verified. */
export const dayReportHtml = (db: ProductionDb, day: number, entries: ReportEntry[], tool: { name: string; version: string }, now = new Date()): string => {
  const production = db.production();
  const shootDay = db.days().find((candidate) => candidate.number === day) ?? db.currentDay();
  const view = db.logView(day);
  const takes = view.scenes.flatMap((scene) => scene.setups.flatMap((setup) => setup.takes.map((take) => ({ scene, setup, take }))));
  const ingest = db.transfers(day).flatMap((transfer) =>
    transfer.destinations.map((leg) => {
      const outcomes = Object.values(leg.outcomes);
      return [
        transfer.card,
        leg.name,
        transfer.files.length,
        formatBytes(transfer.files.reduce((sum, file) => sum + file.size, 0)),
        outcomes.filter((outcome) => outcome.state === 'verified').length,
        outcomes.filter((outcome) => outcome.state === 'already-there').length,
        outcomes.filter((outcome) => outcome.state === 'failed').length,
        transfer.checksum,
        leg.error ?? clock(transfer.finishedAt),
      ];
    }),
  );
  const body = [
    `<header><h1>${html(production.name)} <span class="muted">${html(production.code)}</span></h1>`,
    `<p>Shoot day ${String(shootDay.number).padStart(3, '0')} · ${html(shootDay.date)}${shootDay.locations ? ` · ${html(shootDay.locations)}` : ''}${
      shootDay.operator.name ? ` · DIT ${html(shootDay.operator.name)}` : ''
    }</p>`,
    shootDay.notes ? `<p class="notes">${html(shootDay.notes).replace(/\n/g, '<br>')}</p>` : '',
    `<p class="muted">Day report written ${html(clock(now.toISOString()))} by ${html(tool.name)} ${html(tool.version)} · checksum ${html(production.checksum)} · ${html(production.frameRate)}</p></header>`,
    '<h2>Summary</h2>',
    `<table class="summary"><thead><tr><th>Report</th><th>Covers</th><th>Status</th></tr></thead><tbody>${entries
      .map((entry) => `<tr><td>${html(entry.name)}</td><td>${html(entry.covers)}</td><td class="${WORD[entry.status]}">${html(entry.word)}</td></tr>`)
      .join('')}</tbody></table>`,
    '<h2>Ingest verification</h2>',
    table(['Card', 'Destination', 'Files', 'Size', 'Verified', 'Already there', 'Failed', 'Checksum', 'Finished'], ingest, 'No cards ingested.'),
    '<h2>Scenes and takes</h2>',
    table(
      ['Scene', 'Setup', 'Take', 'Camera A', 'Camera B', 'Sound', 'TC', 'Circle', 'VFX', 'Match', 'Sync'],
      takes.map(({ scene, setup, take }) => [scene.id, setup.id, take.take, take.clipA, take.clipB ?? '', take.sound, take.tc, take.circle ? '◎' : '', take.vfx ? 'VFX' : '', take.match, take.sync]),
      'No script supervisor log imported.',
    ),
    '<h2>Sync</h2>',
    table(
      ['Take', 'Clip', 'Sound', 'Method', 'Offset (frames)', 'Confidence', 'Accepted'],
      db.syncView(day).map((item) => [item.take, item.clip, item.sound, item.method, item.offsetFrames, `${item.confidence}%`, item.accepted ? 'yes' : 'no']),
    ),
    '<h2>Dailies</h2>',
    table(
      ['Take', 'Clip', 'Look', 'Codec', 'Size', 'Result'],
      db.renders(day).map((render) => [render.label, render.clip, render.lut ?? 'none (LOG)', render.codec, render.bytes ? formatBytes(render.bytes) : '', render.error ?? 'done']),
    ),
    '<h2>VFX</h2>',
    table(
      ['Scene', 'Setup', 'Take', 'Clip', 'Note', 'Mirrored on', 'Sent to VC VFX Prep'],
      view.vfx.map((shot) => [
        shot.scene,
        shot.setup,
        shot.take,
        shot.clip,
        shot.note,
        shot.locations.filter((location) => location.state === 'mirrored').map((location) => `${location.destination} (${location.method})`).join(', '),
        clock(shot.sentAt),
      ]),
    ),
    '<h2>Delivery</h2>',
    table(
      ['Package', 'Destination', 'From', 'Files', 'Size', 'Verified', 'Already there', 'Failed', 'Retries', 'Finished'],
      db
        .deliveries(day)
        .map((record) => [record.packageName, record.destination, record.source, record.files, formatBytes(record.bytes), record.verified, record.alreadyThere, record.failed, record.retries, clock(record.finishedAt)]),
      'Nothing delivered.',
    ),
  ].join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${html(production.name)} · Day ${shootDay.number} report</title>
<style>
  @page { size: A4 landscape; margin: 14mm; }
  body { font: 10px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 12.5px; margin: 18px 0 6px; border-bottom: 1px solid #999; padding-bottom: 3px; }
  p { margin: 2px 0; } .muted { color: #666; } .notes { margin: 6px 0; padding: 6px 8px; border-left: 3px solid #999; background: #f4f4f4; }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { font-weight: 600; color: #444; } tr { page-break-inside: avoid; }
  .ok { color: #13703a; font-weight: 600; } .needs { color: #8a5a00; font-weight: 600; } .problem { color: #b3261e; font-weight: 700; } .working { color: #0b57d0; }
</style></head><body>
${body}
</body></html>`;
};
