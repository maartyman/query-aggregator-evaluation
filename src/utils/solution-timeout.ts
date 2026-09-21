import {Worker} from "worker_threads";
import {ExperimentResult} from "./result-builder";
import {Logger} from "./logger";

/** Maximum wall-clock time for one measured query execution. */
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
 * Stops evaluating a solution after its first timed-out measured run.  A timed-out
 * non-worker run is aborted and awaited before the next run begins, preventing it
 * from overlapping later measurements or resetting their shared HTTP metrics.
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
      Logger.warn(`Solution "${solutionKey}" timed out after ${this.timeoutMs}ms; stopping its remaining runs.`);
    }
  }

  public async runSolution(
    solutionKey: string,
    run: (signal: AbortSignal) => Promise<ExperimentResult>
  ): Promise<ExperimentResult | undefined> {
    if (this.isTimedOut(solutionKey)) {
      return undefined;
    }

    const controller = new AbortController();
    let didTimeOut = false;
    const timer = setTimeout(() => {
      didTimeOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const result = await run(controller.signal);
      if (didTimeOut) {
        this.markTimedOut(solutionKey);
        return undefined;
      }
      return result;
    } catch (error) {
      if (didTimeOut || controller.signal.aborted) {
        this.markTimedOut(solutionKey);
        return undefined;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  public runWorkerSolution(solutionKey: string, worker: Worker): Promise<ExperimentResult | undefined> {
    if (this.isTimedOut(solutionKey)) {
      void worker.terminate();
      return Promise.resolve(undefined);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: ExperimentResult | undefined, error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        void worker.terminate();
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };
      const startTimer = (): void => {
        if (timer || settled) {
          return;
        }
        timer = setTimeout(() => {
          this.markTimedOut(solutionKey);
          settle(undefined);
        }, this.timeoutMs);
      };

      worker.on("message", (message: any) => {
        if (message.type === "measurement-started") {
          startTimer();
          return;
        }
        if (message.success) {
          settle(ExperimentResult.deserialize(message.result));
        } else {
          settle(undefined, new Error(message.error));
        }
      });
      worker.on("error", error => settle(undefined, error));
    });
  }

  public finalize(results: ExperimentResult[]): ExperimentResult[] {
    const kept = results.filter(result => !this.isTimedOut(result.experimentId));
    for (const solutionKey of this.timedOut) {
      kept.push(ExperimentResult.timedOut(solutionKey, this.timeoutMs));
    }
    return kept;
  }
}
