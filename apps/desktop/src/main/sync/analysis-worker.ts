import { parentPort, workerData } from 'node:worker_threads';
import { analyse, readFirstMeta, type AnalyseTask } from './analyse';

/**
 * Sync's reading and waveform work, off the main thread. Started by
 * sync-service.ts with a list of jobs as workerData; answers each in turn,
 * then "done".
 */

export type AnalysisJob = { kind: 'meta'; paths: string[] } | { kind: 'analyse'; task: AnalyseTask };
export type AnalysisMessage = { type: 'result'; index: number; value: unknown } | { type: 'done' } | { type: 'error'; message: string };

const port = parentPort!;
const jobs = workerData as AnalysisJob[];

void (async () => {
  try {
    for (const [index, job] of jobs.entries()) {
      const value = job.kind === 'meta' ? await readFirstMeta(job.paths) : await analyse(job.task);
      port.postMessage({ type: 'result', index, value } satisfies AnalysisMessage);
    }
    port.postMessage({ type: 'done' } satisfies AnalysisMessage);
  } catch (cause) {
    port.postMessage({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) } satisfies AnalysisMessage);
  } finally {
    port.close();
  }
})();
