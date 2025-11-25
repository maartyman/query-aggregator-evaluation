import {ExperimentSetup} from "./data-generator";

export interface Experiment {
  generate(): ExperimentSetup;
  run(saveResults: boolean, iterations: number): Promise<void>;
}
