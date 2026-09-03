import {Worker} from "worker_threads";
import {ExperimentResult} from "./result-builder";
import {Logger} from "./logger";

/**
 * Maximum wall-clock time a single evaluation of a solution
 * (local, local indexed, aggregator or aggregator discovered) is allowed to take.
 * Configurable through the SOLUTION_TIMEOUT_MS environment variable, defaults to 10 seconds.
 */
export const SOLUTION_TIMEOUT_MS: number = (() => {
  const raw = process.env.SOLUTION_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return 10_000;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`SOLUTION_TIMEOUT_MS must be a positive number, got: ${raw}`);
  }
  return parsed;
})();

export class SolutionTimeoutError extends Error {
  constructor(public readonly solutionKey: string, public readonly timeoutMs: number) {
    super(`Solution "${solutionKey}" exceeded the ${timeoutMs}ms timeout`);
    this.name = "SolutionTimeoutError";
  }
}

/**
 * Tracks which solutions timed out during a run so that, once a single measured run of a
 * solution exceeds the timeout, that solution is stopped, all of its previously collected
 * (successful) runs are discarded and the solution as a whole is reported as timed out.
 */
export class SolutionTimeoutTracker {
  private readonly timedOut = new Set<string>();

  constructor(public readonly timeoutMs: number = SOLUTION_TIMEOUT_MS) {}

  public isTimedOut(solutionKey: string): boolean {
    return this.timedOut.has(solutionKey);
  }

  private markTimedOut(solutionKey: string): void {
    if (!this.timedOut.has(solutionKey)) {
      this.timedOut.add(solutionKey);
      Logger.warn(
        `Solution "${solutionKey}" timed out after ${this.timeoutMs}ms. ` +
        `Stopping its evaluation, discarding all of its runs and marking the solution as failed (timed out).`
      );
    }
  }

  /**
   * Run a single (non-worker) measured evaluation of a solution with the configured timeout.
   * Returns the produced result, or undefined when the solution timed out (now or earlier).
   */
  public async runSolution(
    solutionKey: string,
    run: () => Promise<ExperimentResult>
  ): Promise<ExperimentResult | undefined> {
    if (this.isTimedOut(solutionKey)) {
      return undefined;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SolutionTimeoutError(solutionKey, this.timeoutMs)), this.timeoutMs);
      });
      return await Promise.race([run(), timeoutPromise]);
    } catch (error) {
      if (error instanceof SolutionTimeoutError) {
        this.markTimedOut(solutionKey);
        return undefined;
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Await the result of a worker-based measured evaluation with the configured timeout.
   * On timeout the worker is terminated and the solution is marked as timed out.
   * Returns the produced result, or undefined when the solution timed out (now or earlier).
   */
  public runWorkerSolution(solutionKey: string, worker: Worker): Promise<ExperimentResult | undefined> {
    if (this.isTimedOut(solutionKey)) {
      void worker.terminate();
      return Promise.resolve(undefined);
    }

    return new Promise<ExperimentResult | undefined>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        void worker.terminate();
        this.markTimedOut(solutionKey);
        resolve(undefined);
      }, this.timeoutMs);

      worker.on("message", (message: any) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (message.success) {
          resolve(ExperimentResult.deserialize(message.result));
        } else {
          reject(new Error(message.error));
        }
      });

      worker.on("error", (error: any) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /**
   * Produce the final list of results: every result that belongs to a timed-out solution is
   * discarded (including runs that finished within the timeout) and replaced by a single
   * timed-out marker result per timed-out solution.
   */
  public finalize(results: ExperimentResult[]): ExperimentResult[] {
    const kept = results.filter(result => !this.isTimedOut(result.experimentId));
    for (const solutionKey of this.timedOut) {
      kept.push(ExperimentResult.timedOut(solutionKey, this.timeoutMs));
    }
    return kept;
  }
}
