# Result Analysis

This folder contains the Dash app for inspecting experiment result JSON files.

Install the Python analysis dependencies:

`python3 -m pip install -r analysis/requirements-analysis.txt`

Run Plotly Dash:

`python3 analysis/dash_app.py`

Then open `http://127.0.0.1:8050`.

Shared data loading for the app lives in:

`analysis/results_data.py`

Validation checks:

- Each comparable run group has the same `totalResults` across local, aggregator, and discovered aggregator modes.
- Each execution variant has stable `totalResults` across repeated recorded runs.
