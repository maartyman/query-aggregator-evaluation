import {ExperimentSetup} from "./data-generator";
import {ExperimentResult} from "./utils/result-builder";

export interface Experiment {
  generate(): ExperimentSetup;
  runLocal(iterations: number): Promise<ExperimentResult[]>;
  runAggregator(iterations: number): Promise<ExperimentResult[]>;
}
