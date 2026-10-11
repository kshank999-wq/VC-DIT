import { parentPort, workerData } from 'node:worker_threads';
import { writeReports, type ReportContext, type WrittenReports } from './reports';
import { runTransfer, type LegPlan, type SourceFile, type TransferProgress, type TransferResult } from './transfer';
import type { ChecksumMethod } from '../../shared/media';

/**
 * One transfer, off the main thread: hashing gigabytes is CPU work, and the
 * window must keep answering while it runs. Started by media-service.ts with
 * the plan as workerData; says "progress" as it goes and "done" at the end.
 * The message "stop" stops it, cleaning up its unverified copies.
 */

export interface WorkerPlan {
  sourceRoot: string;
  files: SourceFile[];
  legs: LegPlan[];
  /** Every destination of the card, for the log; `legs` may be just the one being retried. */
  allLegs: LegPlan[];
  method: ChecksumMethod;
  /** What a file says if the source goes away: the card, or (an upload) the backup it reads from. */
  sourceLost?: string;
  /** Uploads: most bytes a second to write (null for none), and a smaller read size so the limit is smooth. Changed mid-run by a 'limit' message. */
  limit?: number | null;
  chunkBytes?: number;
  contexts: Record<string, ReportContext>;
}

/** What the service may tell a running worker. */
export type WorkerCommand = 'stop' | { type: 'limit'; bytesPerSecond: number | null };

export type WorkerMessage =
  | { type: 'progress'; progress: TransferProgress }
  | { type: 'done'; result: TransferResult; reports: WrittenReports[] }
  | { type: 'error'; message: string };

const port = parentPort!;
const plan = workerData as WorkerPlan;
const controller = new AbortController();
let limit = plan.limit ?? null;
port.on('message', (message: WorkerCommand) => {
  if (message === 'stop') controller.abort();
  else if (message && typeof message === 'object' && message.type === 'limit') limit = message.bytesPerSecond;
});

const post = (message: WorkerMessage) => port.postMessage(message);

void (async () => {
  try {
    const result = await runTransfer(plan.sourceRoot, plan.files, plan.legs, plan.method, {
      signal: controller.signal,
      sourceLost: plan.sourceLost,
      chunkBytes: plan.chunkBytes,
      limit: () => limit,
      onProgress: (progress) => post({ type: 'progress', progress }),
    });
    const reports = await writeReports(result, plan.legs, plan.contexts, plan.allLegs);
    post({ type: 'done', result, reports });
  } catch (cause) {
    post({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) });
  } finally {
    // Stop listening for "stop", so the thread can end.
    port.close();
  }
})();
