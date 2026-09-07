from __future__ import annotations

from html import escape
from pathlib import Path

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import plotly.io as pio

from results_data import (
    VARIANT_COLORS,
    authorization_label,
    authorization_sort_key,
    load_or_build_dataframes,
    variant_sort_key,
    x_sort_key,
)


SITE_DIR = Path(__file__).resolve().parent / "output" / "site"
SITE_PATH = SITE_DIR / "index.html"
DEFAULT_DIEFFICIENCY_METRIC = "medianDief1s"

DIEFFICIENCY_LABELS = {
    "medianDief100ms": "Median dief@100ms",
    "medianDief1s": "Median dief@1s",
    "medianDief2500ms": "Median dief@2.5s",
    "medianDief4s": "Median dief@4s",
    "medianDief10s": "Median dief@10s",
}

VARIANT_SYMBOLS = {
    "Local / no-cache": "circle",
    "Local / indexed-cache": "square",
    "Aggregator discovered": "cross",
    "Aggregator": "diamond",
}


_summary_df, aggregates_df, phase_aggregates_df, _validation = load_or_build_dataframes()


def experiments() -> list[str]:
    return sorted(aggregates_df["experimentName"].dropna().unique())


def authorization_order(dataframe: pd.DataFrame) -> list[str]:
    return sorted(dataframe["authorizationMode"].dropna().unique(), key=authorization_sort_key)


def variant_order(dataframe: pd.DataFrame) -> list[str]:
    return sorted(dataframe["variant"].dropna().unique(), key=variant_sort_key)


def iteration_order(dataframe: pd.DataFrame) -> list[str]:
    return sorted(dataframe["iterationArgs"].dropna().astype(str).unique(), key=x_sort_key)


def sort_line_data(dataframe: pd.DataFrame) -> pd.DataFrame:
    sorted_df = dataframe.copy()
    sorted_df["authorizationSort"] = sorted_df["authorizationMode"].map(authorization_sort_key)
    sorted_df["variantSort"] = sorted_df["variant"].map(variant_sort_key)
    sorted_df["iterationSort"] = sorted_df["iterationArgs"].map(x_sort_key)
    return sorted_df.sort_values(
        ["authorizationSort", "variantSort", "iterationSort"],
        kind="stable",
    )

def chart_html(figure, include_plotlyjs: bool) -> str:
    figure.update_layout(
        autosize=True,
        margin={"l": 64, "r": 24, "t": 56, "b": 64},
        paper_bgcolor="#ffffff",
        plot_bgcolor="#f7f8fb",
    )
    return pio.to_html(
        figure,
        full_html=False,
        include_plotlyjs=include_plotlyjs,
        config={"responsive": True, "displaylogo": False},
    )


def experiment_heading(experiment_name: str, iteration_name: str | None = None) -> str:
    parts = [escape(experiment_name)]
    if iteration_name:
        parts.append(escape(iteration_name))
    return " / ".join(parts)


def authorization_heading(authorization_mode: str) -> str:
    return escape(authorization_label(authorization_mode))


def duration_figure(dataframe: pd.DataFrame, experiment_name: str):
    sorted_df = sort_line_data(dataframe)
    figure = px.line(
        sorted_df,
        x="iterationArgs",
        y="medianDurationMs",
        color="variant",
        symbol="variant",
        facet_col="authorizationMode",
        markers=True,
        category_orders={
            "authorizationMode": authorization_order(dataframe),
            "iterationArgs": iteration_order(dataframe),
            "variant": variant_order(dataframe),
        },
        color_discrete_map=VARIANT_COLORS,
        symbol_map=VARIANT_SYMBOLS,
        hover_data={
            "variant": True,
            "experimentName": True,
            "authorizationMode": True,
            "iterationName": True,
            "iterationArgs": True,
            "runs": True,
            "medianDurationMs": ":.3f",
            "medianHttpRequests": ":.3f",
            "medianResourceRequests": ":.3f",
            "medianAuthorizationTokenRequests": ":.3f",
            "medianSetupHttpRequests": ":.3f",
            "medianOverallHttpRequests": ":.3f",
            "medianServiceAlternatives": ":.3f",
        },
        labels={
            "iterationArgs": "Iteration argument",
            "medianDurationMs": "Median duration (ms)",
            "variant": "Variant",
            "authorizationMode": "Authorization",
            "medianHttpRequests": "Measured median HTTP requests",
            "medianResourceRequests": "Measured median resource requests",
            "medianAuthorizationTokenRequests": "Measured median auth token requests",
            "medianSetupHttpRequests": "Setup median HTTP requests",
            "medianOverallHttpRequests": "Overall median HTTP requests",
            "medianServiceAlternatives": "Median service alternatives",
        },
        title=f"{experiment_name}: median duration",
    )
    figure.update_layout(height=440)
    return figure


def phase_figure(dataframe: pd.DataFrame, experiment_name: str, authorization_mode: str):
    phase_orders = {}
    for row in dataframe.itertuples():
        label = str(row.phaseLabel)
        order = int(row.phaseOrder)
        phase_orders[label] = min(order, phase_orders.get(label, order))
    phase_order = [
        label
        for label, _ in sorted(
            phase_orders.items(),
            key=lambda item: (item[1], item[0]),
        )
    ]
    phase_colors = {
        phase: px.colors.qualitative.Safe[index % len(px.colors.qualitative.Safe)]
        for index, phase in enumerate(phase_order)
    }
    sorted_df = dataframe.copy()
    sorted_df["iterationSort"] = sorted_df["iterationArgs"].map(x_sort_key)
    sorted_df["variantSort"] = sorted_df["variant"].map(variant_sort_key)
    sorted_df = sorted_df.sort_values(["iterationSort", "variantSort", "phaseOrder"])
    figure = go.Figure()
    for phase in phase_order:
        trace_df = sorted_df[sorted_df["phaseLabel"] == phase]
        if trace_df.empty:
            continue
        figure.add_bar(
            x=[trace_df["iterationArgs"], trace_df["variant"]],
            y=trace_df["medianPhaseDurationMs"],
            name=phase,
            marker_color=phase_colors[phase],
            customdata=trace_df[
                [
                    "variant",
                    "experimentName",
                    "authorizationMode",
                    "iterationName",
                    "runs",
                    "averagePhaseDurationMs",
                    "medianPhaseCumulativeMs",
                ]
            ],
            hovertemplate=(
                "Iteration argument=%{x[0]}<br>"
                "Variant=%{customdata[0]}<br>"
                "Experiment=%{customdata[1]}<br>"
                "Authorization=%{customdata[2]}<br>"
                "Iteration=%{customdata[3]}<br>"
                "Phase=" + phase + "<br>"
                "Median phase duration (ms)=%{y:.3f}<br>"
                "Average phase duration (ms)=%{customdata[5]:.3f}<br>"
                "Median cumulative phase duration (ms)=%{customdata[6]:.3f}<br>"
                "Runs=%{customdata[4]}<extra></extra>"
            ),
        )

    figure.update_xaxes(title="Iteration argument / execution strategy")
    figure.update_yaxes(title="Median phase duration (ms)")
    figure.update_layout(
        barmode="stack",
        bargap=0.22,
        bargroupgap=0.08,
        height=480,
        legend_title_text="Phase",
        title=f"{experiment_name}: {authorization_label(authorization_mode)} execution phases",
    )
    return figure


def diefficiency_figure(dataframe: pd.DataFrame, experiment_name: str, metric: str):
    sorted_df = sort_line_data(dataframe)
    figure = px.line(
        sorted_df,
        x="iterationArgs",
        y=metric,
        color="variant",
        symbol="variant",
        facet_col="authorizationMode",
        markers=True,
        category_orders={
            "authorizationMode": authorization_order(dataframe),
            "iterationArgs": iteration_order(dataframe),
            "variant": variant_order(dataframe),
        },
        color_discrete_map=VARIANT_COLORS,
        symbol_map=VARIANT_SYMBOLS,
        hover_data={
            "variant": True,
            "experimentName": True,
            "authorizationMode": True,
            "iterationName": True,
            "iterationArgs": True,
            "runs": True,
            "medianDief100ms": ":.3f",
            "medianDief1s": ":.3f",
            "medianDief2500ms": ":.3f",
            "medianDief4s": ":.3f",
            "medianDief10s": ":.3f",
            "medianDurationMs": ":.3f",
            "medianHttpRequests": ":.3f",
            "medianResourceRequests": ":.3f",
            "medianAuthorizationTokenRequests": ":.3f",
        },
        labels={
            "iterationArgs": "Iteration argument",
            metric: DIEFFICIENCY_LABELS.get(metric, metric),
            "variant": "Variant",
            "authorizationMode": "Authorization",
            "medianDurationMs": "Median duration (ms)",
            "medianHttpRequests": "Median HTTP requests",
            "medianResourceRequests": "Median resource requests",
            "medianAuthorizationTokenRequests": "Median auth token requests",
        },
        title=f"{experiment_name}: {DIEFFICIENCY_LABELS.get(metric, metric)}",
    )
    figure.update_layout(height=440)
    return figure


def chart_section(title: str, chart: str) -> str:
    return f"""
    <article class="chart-section">
      <h2>{title}</h2>
      <div class="chart">{chart}</div>
    </article>
    """


def phase_group_section(title: str, authorization_charts: str) -> str:
    return f"""
    <article class="chart-section phase-group">
      <h2>{title}</h2>
      <div class="authorization-list">{authorization_charts}</div>
    </article>
    """


def authorization_chart(title: str, chart: str) -> str:
    return f"""
    <section class="authorization-chart">
      <h3>{title}</h3>
      <div class="chart">{chart}</div>
    </section>
    """


def build_duration_sections() -> str:
    sections = []
    include_plotlyjs = True
    for experiment_name in experiments():
        experiment_df = aggregates_df[aggregates_df["experimentName"] == experiment_name].copy()
        if experiment_df.empty:
            continue
        chart = chart_html(duration_figure(experiment_df, experiment_name), include_plotlyjs)
        include_plotlyjs = False
        iteration_names = ", ".join(sorted(experiment_df["iterationName"].dropna().astype(str).unique()))
        sections.append(chart_section(experiment_heading(experiment_name, iteration_names), chart))
    return "\n".join(sections)


def build_phase_sections() -> str:
    sections = []
    for experiment_name in experiments():
        experiment_df = phase_aggregates_df[phase_aggregates_df["experimentName"] == experiment_name].copy()
        if experiment_df.empty:
            continue
        iteration_names = ", ".join(sorted(experiment_df["iterationName"].dropna().astype(str).unique()))
        authorization_sections = []
        for authorization_mode in authorization_order(experiment_df):
            authorization_df = experiment_df[experiment_df["authorizationMode"] == authorization_mode].copy()
            if authorization_df.empty:
                continue
            chart = chart_html(
                phase_figure(authorization_df, experiment_name, authorization_mode),
                include_plotlyjs=False,
            )
            authorization_sections.append(authorization_chart(authorization_heading(authorization_mode), chart))
        if authorization_sections:
            sections.append(phase_group_section(
                experiment_heading(experiment_name, iteration_names),
                "\n".join(authorization_sections),
            ))
    return "\n".join(sections)


def build_diefficiency_sections(metric: str = DEFAULT_DIEFFICIENCY_METRIC) -> str:
    sections = []
    for experiment_name in experiments():
        experiment_df = aggregates_df[aggregates_df["experimentName"] == experiment_name].copy()
        if experiment_df.empty:
            continue
        charts = chart_html(
            diefficiency_figure(experiment_df, experiment_name, metric),
            include_plotlyjs=False,
        )
        iteration_names = ", ".join(sorted(experiment_df["iterationName"].dropna().astype(str).unique()))
        sections.append(chart_section(experiment_heading(experiment_name, iteration_names), charts))
    return "\n".join(sections)


def build_static_site() -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Query Aggregator Benchmark Results</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --text: #111827;
      --muted: #5b6472;
      --line: #d8dde6;
      --accent: #176b87;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    header {{
      padding: 28px 32px 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }}
    h1 {{
      margin: 0;
      font-size: clamp(26px, 4vw, 38px);
      font-weight: 700;
      letter-spacing: 0;
    }}
    main {{
      width: 100%;
      padding: 24px 32px 36px;
    }}
    .tabs {{
      display: block;
      width: 100%;
    }}
    .tabs input {{
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }}
    .tab-controls {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 18px;
      border-bottom: 1px solid var(--line);
    }}
    .tab-controls label {{
      display: inline-flex;
      align-items: center;
      height: 42px;
      padding: 0 16px;
      border: 1px solid transparent;
      border-bottom: 0;
      color: var(--muted);
      font-weight: 600;
      cursor: pointer;
    }}
    .tab-controls label:hover {{
      color: var(--text);
    }}
    .panel {{
      display: none;
      width: 100%;
    }}
    #tab-duration:checked ~ .tab-controls label[for="tab-duration"],
    #tab-phases:checked ~ .tab-controls label[for="tab-phases"],
    #tab-diefficiency:checked ~ .tab-controls label[for="tab-diefficiency"] {{
      color: var(--accent);
      border-color: var(--line);
      background: var(--bg);
    }}
    #tab-duration:checked ~ .duration-panel,
    #tab-phases:checked ~ .phases-panel,
    #tab-diefficiency:checked ~ .diefficiency-panel {{
      display: block;
    }}
    .chart-section {{
      width: 100%;
      margin-bottom: 24px;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }}
    h2 {{
      margin: 0 0 14px;
      color: var(--text);
      font-size: 18px;
      line-height: 1.35;
      letter-spacing: 0;
    }}
    h3 {{
      margin: 0 0 10px;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.35;
      letter-spacing: 0;
    }}
    .authorization-list {{
      display: grid;
      grid-template-columns: 1fr;
      gap: 16px;
    }}
    .authorization-chart {{
      width: 100%;
      padding-top: 14px;
      border-top: 1px solid var(--line);
    }}
    .authorization-chart:first-child {{
      padding-top: 0;
      border-top: 0;
    }}
    .chart {{
      width: 100%;
      overflow-x: auto;
    }}
    .chart .js-plotly-plot,
    .chart .plot-container,
    .chart .svg-container {{
      width: 100% !important;
    }}
    @media (max-width: 760px) {{
      header,
      main {{
        padding-left: 16px;
        padding-right: 16px;
      }}
      .tab-controls label {{
        flex: 1 1 auto;
        justify-content: center;
      }}
      .chart-section {{
        padding: 12px;
      }}
    }}
  </style>
</head>
<body>
  <header>
    <h1>Query Aggregator Benchmark Results</h1>
  </header>
  <main>
    <section class="tabs">
      <input type="radio" id="tab-duration" name="benchmark-tab" checked>
      <input type="radio" id="tab-phases" name="benchmark-tab">
      <input type="radio" id="tab-diefficiency" name="benchmark-tab">
      <div class="tab-controls">
        <label for="tab-duration">Duration</label>
        <label for="tab-phases">Execution phases</label>
        <label for="tab-diefficiency">Diefficiency</label>
      </div>

      <div class="panel duration-panel">
        {build_duration_sections()}
      </div>
      <div class="panel phases-panel">
        {build_phase_sections()}
      </div>
      <div class="panel diefficiency-panel">
        {build_diefficiency_sections()}
      </div>
    </section>
  </main>
  <script>
    document.querySelectorAll('input[name="benchmark-tab"]').forEach((input) => {{
      input.addEventListener("change", () => {{
        document.querySelectorAll(".panel:not([style]) .js-plotly-plot, .panel .js-plotly-plot").forEach((plot) => {{
          if (plot.offsetParent !== null && window.Plotly) {{
            window.Plotly.Plots.resize(plot);
          }}
        }});
      }});
    }});
  </script>
</body>
</html>
"""


def main() -> None:
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    SITE_PATH.write_text(build_static_site(), encoding="utf-8")
    print(SITE_PATH)


if __name__ == "__main__":
    main()
