interface Experiment {
  generate(): string;
  setupAggregators(): Promise<void>;
  run(saveResults: boolean, iterations: number): Promise<void>;
}
