import * as fs from 'fs';
import * as path from 'path';
import { getHttpMetricsSnapshot, resetHttpMetrics, type HttpMetricsSnapshot } from './http-metrics';

export interface PhaseTiming {
  label: string;
  durationMs: number;
  cumulativeMs: number;
}

export class ExperimentResult {
  public experimentId: string;
  public totalDuration: number; // Total query duration in ms
  public dief100ms: number; // Diefficiency at 100 milliseconds
  public dief1s: number; // Diefficiency at 1 second
  public dief10s: number; // Diefficiency at 10 seconds
  public timestamps: [number, number][]; // [timestamp_ms, cumulative_count] pairs
  public totalResults: number;
  public phaseTimings: PhaseTiming[];
  public parameters?: Record<string, any>;

  constructor(
    experimentId: string,
    totalDuration: number,
    dief100ms: number,
    dief1s: number,
    dief10s: number,
    timestamps: [number, number][],
    totalResults: number,
    phaseTimings: PhaseTiming[] = [],
    parameters?: Record<string, any>
  ) {
    this.experimentId = experimentId;
    this.totalDuration = totalDuration;
    this.dief100ms = dief100ms;
    this.dief1s = dief1s;
    this.dief10s = dief10s;
    this.timestamps = timestamps;
    this.totalResults = totalResults;
    this.phaseTimings = phaseTimings;
    this.parameters = parameters;
  }

  /**
   * Serialize result to JSON string for worker communication
   */
  public serialize(): string {
    return JSON.stringify(this);
  }

  public static deserialize(str: string): ExperimentResult {
    const obj = JSON.parse(str);
    return new ExperimentResult(
      obj.experimentId,
      obj.totalDuration,
      obj.dief100ms,
      obj.dief1s,
      obj.dief10s,
      obj.timestamps,
      obj.totalResults,
      obj.phaseTimings ?? [],
      obj.parameters
    );
  }

  /**
   * Print result in a human-readable format
   */
  public print(): void {
  }

  /**
   * Save result to a JSON file
   */
  public save(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, this.serialize());
  }

  /**
   * Load result from a JSON file
   */
  public static fromFile(filePath: string): ExperimentResult {
    const content = fs.readFileSync(filePath, 'utf8');
    return ExperimentResult.deserialize(content);
  }

  /**
   * Create ExperimentResult from result iterator
   */
  public static async fromIterator(
    experimentId: string,
    startTime: [number, number],
    resultIterator: any,
    parameters?: Record<string, any>
  ): Promise<ExperimentResult> {
    let timestamps: [number,number][] = [];

    return new Promise((resolve, reject) => {
      resultIterator.on('data', (binding: any) => {
        const relativeTime = process.hrtime(startTime);
        timestamps.push(relativeTime);
      });

      resultIterator.on('end', () => {
        const endTime = process.hrtime(startTime);
        const totalDuration = endTime[0] * 1000 + endTime[1] / 1_000_000;

        if (timestamps.length === 0) {
          reject(new Error(`No results received from iterator during experiment ${experimentId}.`));
          return;
        }

        getHttpMetricsSnapshot().then(metrics => {
          const { setupHttpMetrics, ...cleanParameters } = parameters ?? {};
          const setupMetrics = setupHttpMetrics as HttpMetricsSnapshot | undefined;
          resolve(new ExperimentResult(
            experimentId,
            totalDuration,
            this.calculateDiefficiency(timestamps, [0,100_000_000]), // 100ms
            this.calculateDiefficiency(timestamps, [1,0]), // 1s
            this.calculateDiefficiency(timestamps, [10,0]), // 10s
            timestamps,
            timestamps.length,
            this.iteratorPhaseTimings(timestamps[0], totalDuration),
            {
              ...metrics,
              ...ExperimentResult.setupMetricsParameters(metrics, setupMetrics),
              queryResultCount: timestamps.length,
              ...cleanParameters
            }
          ));
        }).catch(reject);
      });

      resultIterator.on('error', (error: any) => {
        console.error('Result iterator error:', error);
        reject(error);
      });
    });
  }

  /**
   * Create ExperimentResult from fetching a json result
   */
  public static async fromJson(
    experimentId: string,
    startTime: [number, number],
    jsonResult: any,
    parameters?: Record<string, any>,
    phaseTimings?: PhaseTiming[]
  ): Promise<ExperimentResult> {
    const endTime = process.hrtime(startTime);
    const totalDuration = endTime[0] * 1000 + endTime[1] / 1_000_000;

    const timestamps: [number,number][] = [];
    for (let i = 0; i < jsonResult.results.bindings.length; i++) {
      timestamps.push(endTime);
    }

    if (timestamps.length === 0) {
      throw new Error(`No results received from JSON result during experiment: ${experimentId}`);
    }

    const metrics = await getHttpMetricsSnapshot();
    const { setupHttpMetrics, ...cleanParameters } = parameters ?? {};
    const setupMetrics = setupHttpMetrics as HttpMetricsSnapshot | undefined;

    return new ExperimentResult(
      experimentId,
      totalDuration,
      this.calculateDiefficiency(timestamps, [0,100_000_000]), // 100ms
      this.calculateDiefficiency(timestamps, [1,0]), // 1s
      this.calculateDiefficiency(timestamps, [10,0]), // 10s
      timestamps,
      timestamps.length,
      phaseTimings ?? [],
      {
        ...metrics,
        ...ExperimentResult.setupMetricsParameters(metrics, setupMetrics),
        queryResultCount: timestamps.length,
        ...cleanParameters
      }
    );
  }

  public static startMeasurement(): [number, number] {
    resetHttpMetrics();
    return process.hrtime();
  }

  public static millisecondsSince(startTime: [number, number]): number {
    const duration = process.hrtime(startTime);
    return duration[0] * 1000 + duration[1] / 1_000_000;
  }

  private static iteratorPhaseTimings(firstTimestamp: [number, number], totalDuration: number): PhaseTiming[] {
    const firstResultMs = firstTimestamp[0] * 1000 + firstTimestamp[1] / 1_000_000;
    return [
      {
        label: "First result arrives",
        durationMs: firstResultMs,
        cumulativeMs: firstResultMs,
      },
      {
        label: "Iterator finishes",
        durationMs: Math.max(0, totalDuration - firstResultMs),
        cumulativeMs: totalDuration,
      },
    ];
  }

  private static setupMetricsParameters(
    metrics: HttpMetricsSnapshot,
    setupMetrics?: HttpMetricsSnapshot
  ): Record<string, number> {
    if (!setupMetrics) {
      return {};
    }

    return {
      setupHttpRequests: setupMetrics.totalHttpRequests,
      setupHTTPRequests: setupMetrics.totalHTTPRequests,
      setupResourceRequests: setupMetrics.resourceRequests,
      setupAuthorizationTokenRequests: setupMetrics.authorizationTokenRequests,
      setupNumberOfTriples: setupMetrics.numberOfTriples,
      overallHttpRequests: setupMetrics.totalHttpRequests + metrics.totalHttpRequests,
      overallHTTPRequests: setupMetrics.totalHTTPRequests + metrics.totalHTTPRequests,
      overallResourceRequests: setupMetrics.resourceRequests + metrics.resourceRequests,
      overallAuthorizationTokenRequests: setupMetrics.authorizationTokenRequests + metrics.authorizationTokenRequests,
      overallNumberOfTriples: setupMetrics.numberOfTriples + metrics.numberOfTriples,
    };
  }

  private static calculateDiefficiency(timestamps: [number,number][], timeMs: [number,number]): number {
    if (timestamps.length === 0) {
      return 0;
    }

    // Convert hrtime target time to milliseconds
    const targetTimeMs = timeMs[0] * 1000 + timeMs[1] / 1_000_000;

    // Convert hrtime timestamps to milliseconds and create [time_ms, cumulative_count] pairs
    const timeValuePairs: [number, number][] = timestamps.map((hrtime, index) => {
      const timeInMs = hrtime[0] * 1000 + hrtime[1] / 1_000_000;
      return [timeInMs, index + 1]; // cumulative count
    });

    // Sort by time to ensure chronological order
    const sortedPairs = timeValuePairs.sort((a, b) => a[0] - b[0]);

    // Create a subtrace with only timestamps <= targetTimeMs
    let subtrace: [number, number][] = [];
    for (const [time, count] of sortedPairs) {
      if (time <= targetTimeMs) {
        subtrace.push([time, count]);
      }
    }

    // Add a final point at targetTimeMs with the last count if we haven't reached targetTimeMs yet
    if (subtrace.length > 0) {
      const lastTime = subtrace[subtrace.length - 1][0];
      const lastCount = subtrace[subtrace.length - 1][1];

      if (lastTime < targetTimeMs) {
        // Continue the line to targetTimeMs with the same count (continue_to_end behavior)
        subtrace.push([targetTimeMs, lastCount]);
      }
    }

    // Calculate area under curve using trapezoidal rule
    if (subtrace.length <= 1) {
      return 0;
    }

    let area = 0;
    for (let i = 1; i < subtrace.length; i++) {
      const [prevTime, prevCount] = subtrace[i - 1];
      const [currTime, currCount] = subtrace[i];

      // Trapezoidal rule: area = (width) * (average height)
      const width = currTime - prevTime;
      const avgHeight = (prevCount + currCount) / 2;
      area += width * avgHeight;
    }

    return area;
  }
}
