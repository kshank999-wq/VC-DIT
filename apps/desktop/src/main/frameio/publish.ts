import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { FrameioTarget } from '../../shared/project';
import type { ProductionDb } from '../db/production-db';
import type { FrameioApi } from './api';
import { sendParts, waitUploaded } from './upload';

/**
 * Publishing the day's dailies to the production's Frame.io project (spec
 * §4.8), into Dailies / Day 014 · 2026-10-05 / Sc 14 / <daily>, folders made
 * as needed and found again by name on the next run.
 *
 * Each rendered daily is sent once: a daily already on Frame.io (this render
 * of it, by its checksum, in this project) is not sent again; a re-rendered
 * one is sent as a new file beside the old, which keeps its review comments.
 * A daily counts as published only once Frame.io says its upload is
 * complete. One that fails is recorded with why, its half-made file removed,
 * and is tried again on the next publish; the rest carry on. A file of the
 * same name and size already complete in the folder (a run cut off after
 * the upload but before it was recorded) is taken as published.
 *
 * The take's notes, circle and look go on the file as its first comment, so
 * reviewers see what the set saw.
 */

type Fetch = typeof fetch;

export interface PublisherDeps {
  db: () => ProductionDb;
  /** Frame.io as the signed-in person, or null when no one is. */
  session: () => Promise<FrameioApi | null>;
  changed: () => void;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface Item {
  takeId: string;
  clip: string;
  output: string;
  checksum: string | null;
  scene: string;
  comment: string | null;
  previous: { fileId: string | null; state: 'done' | 'failed'; projectId: string } | null;
}

const pad = (value: number) => String(value).padStart(3, '0');
const sceneFolder = (scene: string) => `Sc ${scene || '—'}`;

export class FrameioPublisher {
  activity: string | null = null;
  problem: string | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly deps: PublisherDeps) {}

  busy(): boolean {
    return this.controller !== null;
  }

  stop() {
    this.controller?.abort();
  }

  /** The day's dailies not yet on Frame.io (this render, in this project). */
  pending(day: number): Item[] {
    const db = this.deps.db();
    const target = db.frameioTarget();
    if (!target) return [];
    const plans = new Map(db.dailiesPlan(day, { ...db.dailiesSettings(), include: 'all', scenes: [] }).map((plan) => [`${plan.takeId}|${plan.clip}`, plan]));
    return db
      .renders(day)
      .filter((render) => render.state === 'done' && render.frameio?.state !== 'done')
      .map((render) => {
        const plan = plans.get(`${render.takeId}|${render.clip}`);
        const previous = db.frameioUpload(day, render.takeId, render.clip);
        const notes = [
          plan ? `Sc ${plan.scene} / ${plan.setup || '—'} / T${plan.take}` : render.label,
          plan?.circle ? 'Circled' : null,
          render.lut ? `Look: ${render.lut}` : null,
          plan?.notes ? `Notes: ${plan.notes}` : null,
        ].filter(Boolean);
        return {
          takeId: render.takeId,
          clip: render.clip,
          output: render.output,
          checksum: render.checksum,
          scene: plan?.scene ?? render.takeId.split('|')[0] ?? '',
          comment: notes.length > 1 ? notes.join(' · ') : null,
          previous: previous && previous.projectId === target.projectId ? previous : null,
        };
      });
  }

  /** Start publishing the open day; resolves once it has started, with how many dailies it will send. */
  async start(): Promise<{ files: number }> {
    if (this.controller) throw new Error('Dailies are already being published to Frame.io.');
    const db = this.deps.db();
    const target = db.frameioTarget();
    if (!target) throw new Error('Choose the Frame.io project to publish to first.');
    const api = await this.deps.session();
    if (!api) throw new Error('Connect Frame.io first.');
    const day = db.currentDay();
    const items = this.pending(day.number);
    if (items.length === 0) throw new Error('Every rendered daily of the day is already on Frame.io.');
    const controller = new AbortController();
    this.controller = controller;
    this.problem = null;
    this.activity = `Publishing ${items.length} dail${items.length === 1 ? 'y' : 'ies'} to Frame.io…`;
    this.deps.changed();
    void this.run(api, target, day, items, controller.signal).finally(() => {
      this.controller = null;
      this.activity = null;
      this.deps.changed();
    });
    return { files: items.length };
  }

  private async run(api: FrameioApi, target: FrameioTarget, day: { number: number; date: string }, items: Item[], signal: AbortSignal) {
    const db = this.deps.db;
    const folders = new Map<string, string>();
    /** A folder by its path under the project, found by name or made. */
    const folder = async (path: string[]): Promise<string> => {
      let parent = target.rootFolderId;
      for (let i = 0; i < path.length; i += 1) {
        const key = path.slice(0, i + 1).join('/');
        const known = folders.get(key);
        if (known) {
          parent = known;
          continue;
        }
        const existing = (await api.folders(target.accountId, parent)).find((candidate) => candidate.name === path[i]);
        parent = existing ? existing.id : (await api.createFolder(target.accountId, parent, path[i]!)).id;
        folders.set(key, parent);
      }
      return parent;
    };
    const failures: string[] = [];
    let done = 0;
    for (const [index, item] of items.entries()) {
      if (signal.aborted) break;
      const name = basename(item.output);
      const record = (state: 'done' | 'failed', fields: { fileId: string | null; bytes: number; error: string | null; viewUrl: string | null }) =>
        db().saveFrameioUpload(day.number, item.takeId, item.clip, { projectId: target.projectId, name, checksum: item.checksum, state, ...fields });
      let fileId: string | null = null;
      let bytes = 0;
      try {
        bytes = (await stat(item.output)).size;
        const where = await folder(['Dailies', `Day ${pad(day.number)} · ${day.date}`, sceneFolder(item.scene)]);
        // A half-made file from a failed try goes, so the folder holds only whole dailies.
        if (item.previous?.state === 'failed' && item.previous.fileId) await api.deleteFile(target.accountId, item.previous.fileId).catch(() => undefined);
        const already = (await api.files(target.accountId, where)).find((file) => file.name === name && file.size === bytes && file.status !== 'created');
        if (already && item.previous?.state !== 'done') {
          record('done', { fileId: already.id, bytes, error: null, viewUrl: already.viewUrl });
          done += 1;
          continue;
        }
        const show = (sent: number) => {
          this.activity = `Publishing ${index + 1} of ${items.length} · ${name} · ${bytes ? Math.floor((sent / bytes) * 100) : 100}%`;
          this.deps.changed();
        };
        show(0);
        const created = await api.createLocalUpload(target.accountId, where, name, bytes);
        fileId = created.id;
        await sendParts(item.output, created.parts, bytes, created.mediaType, {
          ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
          ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
          signal,
          onProgress: show,
        });
        this.activity = `Publishing ${index + 1} of ${items.length} · ${name} · Frame.io is taking it in…`;
        this.deps.changed();
        const complete = await waitUploaded(api, target.accountId, created.id, { ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}), signal });
        if (!complete) throw new Error('Frame.io says the upload failed.');
        record('done', { fileId, bytes, error: null, viewUrl: created.viewUrl });
        done += 1;
        if (item.comment) await api.comment(target.accountId, created.id, item.comment).catch(() => undefined);
      } catch (cause) {
        if (signal.aborted) {
          record('failed', { fileId, bytes, error: 'Stopped before it finished.', viewUrl: null });
          break;
        }
        const message = (cause as Error).message;
        record('failed', { fileId, bytes, error: message, viewUrl: null });
        failures.push(`${name}: ${message}`);
        // Signed out, or the project gone: the rest would fail the same way.
        const status = (cause as { status?: number }).status;
        if (status === 401 || status === 404) {
          failures.push('Publishing stopped.');
          break;
        }
      }
      this.deps.changed();
    }
    if (signal.aborted) this.problem = `Stopped. ${done} dail${done === 1 ? 'y' : 'ies'} published; the rest go on the next publish.`;
    else if (failures.length) this.problem = `${done} of ${items.length} published. ${failures.join(' ')}`;
  }
}
