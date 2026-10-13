import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DELIVERY_PARTS, type DeliveryPart, type DeliveryPartId, type DeliveryPlace } from '../../shared/project';
import { dayFolder, segment } from '../media/rules';
import { listSource, type SourceFile } from '../media/transfer';
import { capacityOf } from '../media/volumes';

/**
 * What of the day is where (spec §4.10 preflight). Each part of the day
 * folder (camera originals, dailies, VFX…) is looked for on every drive and
 * folder VC DIT knows; the one holding most of it is where a delivery reads
 * it from. For every other place, the bytes it already holds (same name,
 * same size) are counted, so preflight asks only for the space a delivery
 * will really use.
 */

export interface Place {
  id: string;
  name: string;
  kind: string;
  root: string;
}

export interface DayRef {
  production: { name: string; code: string };
  day: { number: number; date: string };
}

/** PRODUCTION/SHOOT_DAY_###_DATE on a drive. */
export const dayDir = (root: string, ref: DayRef): string => join(root, segment(ref.production.name || ref.production.code), dayFolder(ref.day));

export interface ScannedPart extends DeliveryPart {
  /** The day folder on the source, and the part's files relative to it ("CAMERA_ORIGINALS/A015/…"). */
  dir: string | null;
  list: SourceFile[];
}

export interface Inventory {
  places: DeliveryPlace[];
  parts: ScannedPart[];
}

/** One part's files on one drive, relative to the day folder. Nothing there is an empty list. */
export const listPart = async (day: string, id: DeliveryPartId): Promise<SourceFile[]> => {
  const part = DELIVERY_PARTS.find((candidate) => candidate.id === id)!;
  try {
    const { files } = await listSource(join(day, ...part.folder.split('/')));
    return files.filter((file) => !part.exclude?.includes(file.path.split('/')[0]!)).map((file) => ({ ...file, path: `${part.folder}/${file.path}` }));
  } catch {
    return [];
  }
};

/** Bytes of these files already at `day` under the same names and sizes. */
const presentBytes = async (day: string, files: SourceFile[]): Promise<number> => {
  let total = 0;
  for (let i = 0; i < files.length; i += 64) {
    const sizes = await Promise.all(
      files.slice(i, i + 64).map(async (file) => {
        try {
          return (await stat(join(day, ...file.path.split('/')))).size === file.size ? file.size : 0;
        } catch {
          return 0;
        }
      }),
    );
    total += sizes.reduce((sum, size) => sum + size, 0);
  }
  return total;
};

export const scanInventory = async (places: Place[], ref: DayRef): Promise<Inventory> => {
  const found = await Promise.all(
    places.map(async (place) => {
      const capacity = await capacityOf(place.root);
      return { place, capacity, day: dayDir(place.root, ref) };
    }),
  );
  const online = found.filter((entry) => entry.capacity !== null);
  const parts: ScannedPart[] = [];
  for (const part of DELIVERY_PARTS) {
    const listings = await Promise.all(
      online.map(async (entry) => ({
        entry,
        files: await listPart(entry.day, part.id),
      })),
    );
    const bytesOf = (files: SourceFile[]) => files.reduce((sum, file) => sum + file.size, 0);
    // Most bytes wins; on a tie, the first place (destination volumes before folders).
    const best = listings.reduce<(typeof listings)[number] | null>(
      (top, listing) => (listing.files.length && (!top || bytesOf(listing.files) > bytesOf(top.files)) ? listing : top),
      null,
    );
    const present: Record<string, number> = {};
    if (best) {
      for (const listing of listings) if (listing !== best) present[listing.entry.place.id] = await presentBytes(listing.entry.day, best.files);
    }
    parts.push({
      id: part.id,
      sourceId: best?.entry.place.id ?? null,
      source: best?.entry.place.name ?? null,
      files: best?.files.length ?? 0,
      bytes: best ? bytesOf(best.files) : 0,
      present,
      dir: best?.entry.day ?? null,
      list: best?.files ?? [],
    });
  }
  return {
    places: found.map(({ place, capacity }) => ({
      id: place.id,
      name: place.name,
      kind: place.kind,
      root: place.root,
      freeBytes: capacity?.freeBytes ?? null,
      totalBytes: capacity?.totalBytes ?? null,
    })),
    parts,
  };
};
