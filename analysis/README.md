# Result Analysis

This folder contains lightweight tooling for checking and plotting experiment result JSON files.

Open and run:

`analysis/analyze-results.ipynb`

Outputs:

- `summary.csv`: one row per result file with timing, result count, HTTP metrics, and parameters.
- `aggregates.csv`: grouped median/average duration and result counts.
- `validation.json`: machine-readable consistency checks.
- `validation.md`: human-readable validation report.
- `plots/*.svg`: median duration bar charts grouped by experiment and authorization mode.
- `line-plots/*.svg`: median duration line charts split by experiment and authorization mode, with the iteration dimension on the x axis and execution variants as lines.

To generate the line plots from an existing `summary.csv`:

`python3 analysis/plot-iteration-lines.py`

Validation checks:

- Each comparable run group has the same `totalResults` across local, aggregator, and discovered aggregator modes.
- Each execution variant has stable `totalResults` across repeated recorded runs.
