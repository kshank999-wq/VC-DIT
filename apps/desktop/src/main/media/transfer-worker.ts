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
  contexts: Record<string, ReportContext>;
}

export type WorkerMessage =
  | { type: 'progress'; progress: TransferProgress }
  | { type: 'done'; result: TransferResult; reports: WrittenReports[] }
  | { type: 'error'; message: string };

const port = parentPort!;
const plan = workerData as WorkerPlan;
const controller = new AbortController();
port.on('message', (message) => {
  if (message === 'stop') controller.abort();
});

const post = (message: WorkerMessage) => port.postMessage(message);

void (async () => {
  try {
    const result = await runTransfer(plan.sourceRoot, plan.files, plan.legs, plan.method, {
      signal: controller.signal,
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
