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
