interface Experiment {
  generate(): void;
  run(saveResults: boolean, iterations: number): Promise<void>;
}
