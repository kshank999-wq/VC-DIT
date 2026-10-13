import { open } from 'node:fs/promises';
import type { FrameioApi, UploadPart } from './api';

/**
 * Sending one file's bytes to Frame.io: the parts Frame.io asked for, each
 * PUT to its presigned storage URL with the "x-amz-acl: private" header it
 * requires, read from the file as they go (never the whole file in memory),
 * two at a time. A part that fails is sent again (four tries, backing off);
 * one that still fails fails the file. Then Frame.io is asked until it says
 * the upload is complete: only then is the file counted as on Frame.io.
 */

type Fetch = typeof fetch;

export interface PartsOptions {
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (sent: number, total: number) => void;
  /** Parts in flight at once. */
  parallel?: number;
}

/** Where each part starts and how long it is: the sizes Frame.io gave, or the file split evenly when they do not add up. */
export const partRanges = (parts: UploadPart[], fileSize: number): { start: number; length: number }[] => {
  if (parts.length === 0) throw new Error('Frame.io gave no upload address for this file.');
  const given = parts.reduce((sum, part) => sum + part.size, 0);
  const sizes = given === fileSize && parts.every((part) => part.size > 0) ? parts.map((part) => part.size) : parts.map(() => Math.ceil(fileSize / parts.length));
  let start = 0;
  return sizes.map((size) => {
    const length = Math.max(0, Math.min(size, fileSize - start));
    const range = { start, length };
    start += length;
    return range;
  });
};

const BACKOFF = [1000, 2000, 4000, 8000];

export const sendParts = async (path: string, parts: UploadPart[], fileSize: number, contentType: string | null, options: PartsOptions = {}): Promise<void> => {
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const ranges = partRanges(parts, fileSize);
  const file = await open(path, 'r');
  let sent = 0;
  try {
    const sendOne = async (index: number) => {
      const { start, length } = ranges[index]!;
      const body = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await file.read(body, read, length - read, start + read);
        if (bytesRead === 0) throw new Error('The file got shorter while it was being uploaded.');
        read += bytesRead;
      }
      for (let attempt = 0; ; attempt += 1) {
        options.signal?.throwIfAborted();
        try {
          const response = await fetcher(parts[index]!.url, {
            method: 'PUT',
            headers: { 'Content-Type': contentType || 'application/octet-stream', 'x-amz-acl': 'private' },
            body,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          if (response.ok) break;
          // A presigned address that has run out: trying it again will not help.
          if (response.status === 403) throw Object.assign(new Error('The upload address expired. The file will be sent again from the start.'), { fatal: true });
          throw new Error(`storage answered ${response.status}`);
        } catch (cause) {
          if (options.signal?.aborted || (cause as { fatal?: boolean }).fatal) throw cause;
          if (attempt >= BACKOFF.length) throw new Error(`Part ${index + 1} of ${ranges.length} would not upload: ${(cause as Error).message}.`);
          await sleep(BACKOFF[attempt]!);
        }
      }
      sent += length;
      options.onProgress?.(sent, fileSize);
    };
    let next = 0;
    const lane = async () => {
      while (next < ranges.length) {
        const index = next;
        next += 1;
        await sendOne(index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.parallel ?? 2, ranges.length) }, lane));
  } finally {
    await file.close();
  }
};

/** Ask Frame.io until the upload is complete (true), failed (false), or it is still not done after `timeoutMs`. */
export const waitUploaded = async (
  api: FrameioApi,
  accountId: string,
  fileId: string,
  options: { sleep?: (ms: number) => Promise<void>; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> => {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  for (let wait = 1000; ; wait = Math.min(15_000, wait * 2)) {
    options.signal?.throwIfAborted();
    const status = await api.uploadStatus(accountId, fileId);
    if (status.complete) return true;
    if (status.failed) return false;
    if (Date.now() > deadline) throw new Error('Frame.io has not finished taking the file in. It will be checked again on the next publish.');
    await sleep(wait);
  }
};
