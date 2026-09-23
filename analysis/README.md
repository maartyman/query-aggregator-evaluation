# Result Analysis

This folder contains the static benchmark website generator for inspecting experiment result JSON files.

Install the Python analysis dependencies:

`python3 -m pip install -r analysis/requirements-analysis.txt`

Create the static benchmark website:

`python3 analysis/static_site.py`

The generated site is written to:

`analysis/output/site/index.html`

Shared data loading for the app lives in:

`analysis/results_data.py`

Duration charts show the median per benchmark point with two-sided 95% distribution-free confidence intervals for the population median. Timed-out runs are excluded from all analysis outputs.
