import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { OrganizeLink, OrganizeView } from '../db/production-db';
import { REFERENCE_FILES } from './view';

/**
 * The scene folders read back (spec §4.4, §8): for every clip, on every
 * destination holding it, is it in the folder its take says, and is what is
 * there the card's own data? A hard link must be the same file as the card
 * copy on that drive; a reference must name this clip and its files, and
 * those files must be in the card folder at their size. Nothing is changed
 * here: what is wrong is reported, and can be put back.
 */

export type CheckProblem = 'not placed' | 'missing' | 'not the card copy' | 'reference wrong' | 'card copy missing';

export interface CheckFinding {
  clip: string;
  card: string;
  kind: OrganizeView['kind'];
  legId: string;
  destination: string;
  /** Where it should be, under the day folder. */
  relDir: string;
  problem: CheckProblem;
  detail: string;
}

const split = (path: string) => path.split('/');
const statOf = (path: string) => stat(path).then((info) => info, () => null);

/** One placed clip on one destination, read back. Null when all is well. */
export const checkLink = async (view: OrganizeView, link: OrganizeLink): Promise<Pick<CheckFinding, 'problem' | 'detail'> | null> => {
  for (const file of view.files) {
    const original = await statOf(join(link.cardDir, ...split(file.path)));
    if (!original || original.size !== file.size) return { problem: 'card copy missing', detail: `${file.path} is not in the card folder at its size.` };
  }
  if (link.method === 'Reference') {
    let body: { schema?: string; clip?: string; files?: { path: string; size: number }[] };
    try {
      body = JSON.parse(await readFile(join(link.targetDir, REFERENCE_FILES[0]!), 'utf8')) as typeof body;
    } catch {
      return { problem: 'missing', detail: 'The reference file is not there.' };
    }
    const named = new Map((body.files ?? []).map((file) => [file.path, file.size]));
    if (body.schema !== 'vcdit.view-reference/1' || body.clip !== view.clip || view.files.some((file) => named.get(file.path) !== file.size)) {
      return { problem: 'reference wrong', detail: 'The reference file does not name this clip and its files.' };
    }
    return null;
  }
  for (const file of view.files) {
    const here = await statOf(join(link.targetDir, ...split(file.path)));
    if (!here) return { problem: 'missing', detail: `${file.path} is not in the take folder.` };
    const original = (await statOf(join(link.cardDir, ...split(file.path))))!;
    if (here.dev !== original.dev || here.ino !== original.ino) return { problem: 'not the card copy', detail: `${file.path} in the take folder is not the card's data.` };
  }
  return null;
};

/** Every clip that should be placed, on every destination, against what was placed and what is there now. */
export const checkViews = async (views: OrganizeView[], links: OrganizeLink[]): Promise<CheckFinding[]> => {
  const byKey = new Map(links.map((link) => [`${link.kind}|${link.card}|${link.clip}|${link.legId}`, link]));
  const findings: CheckFinding[] = [];
  for (const view of views) {
    for (const location of view.locations) {
      const base = { clip: view.clip, card: view.card, kind: view.kind, legId: location.legId, destination: location.name, relDir: view.relDir };
      const link = byKey.get(`${view.kind}|${view.card}|${view.clip}|${location.legId}`);
      if (!link || link.state !== 'placed' || link.relDir !== view.relDir) {
        findings.push({ ...base, problem: 'not placed', detail: link?.error ?? 'Not placed yet.' });
        continue;
      }
      const wrong = await checkLink(view, link);
      if (wrong) findings.push({ ...base, ...wrong });
    }
  }
  return findings;
};
