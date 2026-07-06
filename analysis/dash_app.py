from __future__ import annotations

from dash import Dash, Input, Output, dash_table, dcc, html
import plotly.express as px

from results_data import (
    VARIANT_COLORS,
    authorization_label,
    authorization_sort_key,
    load_or_build_dataframes,
    variant_sort_key,
    x_sort_key,
)


summary_df, aggregates_df, phase_aggregates_df, validation = load_or_build_dataframes()

DEFAULT_EXPERIMENTS = sorted(aggregates_df["experimentName"].dropna().unique())
DEFAULT_AUTHORIZATION_MODES = sorted(
    aggregates_df["authorizationMode"].dropna().unique(),
    key=authorization_sort_key,
)
DEFAULT_EXECUTION_TYPES = sorted(aggregates_df["executionType"].dropna().unique())


def options(values):
    return [{"label": value or "-", "value": value} for value in values]


def authorization_options(values):
    return [{"label": authorization_label(value), "value": value} for value in values]


def filter_control(label, control):
    return html.Div([html.Label(label), control], style={"display": "grid", "gap": "4px"})


def diefficiency_options():
    return [
        {"label": "dief@100ms", "value": "medianDief100ms"},
        {"label": "dief@1s", "value": "medianDief1s"},
        {"label": "dief@2.5s", "value": "medianDief2500ms"},
        {"label": "dief@4s", "value": "medianDief4s"},
        {"label": "dief@10s", "value": "medianDief10s"},
    ]


def y_axis_range(min_value, max_value):
    if min_value is None and max_value is None:
        return None
    if min_value is not None and max_value is not None and min_value >= max_value:
        return None
    return [min_value, max_value]


app = Dash(__name__)
server = app.server

app.layout = html.Div(
    [
        html.H1("Query Aggregator Results"),
        html.Div(
            [
                html.Div([html.Strong("Result files"), html.Div(f"{len(summary_df):,}")]),
                html.Div([html.Strong("Aggregate rows"), html.Div(f"{len(aggregates_df):,}")]),
                html.Div([html.Strong("Phase rows"), html.Div(f"{len(phase_aggregates_df):,}")]),
                html.Div([html.Strong("Validation"), html.Div("OK" if validation["ok"] else "FAILED")]),
                html.Div(
                    [
                        html.Strong("Comparable mismatches"),
                        html.Div(str(validation["totals"]["comparableMismatches"])),
                    ]
                ),
            ],
            style={"display": "grid", "gridTemplateColumns": "repeat(5, 1fr)", "gap": "12px"},
        ),
        html.Div(
            [
                filter_control(
                    "Experiment",
                    dcc.Dropdown(
                        id="experiment-filter",
                        options=options(DEFAULT_EXPERIMENTS),
                        value=DEFAULT_EXPERIMENTS,
                        multi=True,
                    ),
                ),
                filter_control(
                    "Authorization",
                    dcc.Dropdown(
                        id="authorization-filter",
                        options=authorization_options(DEFAULT_AUTHORIZATION_MODES),
                        value=DEFAULT_AUTHORIZATION_MODES,
                        multi=True,
                    ),
                ),
                filter_control(
                    "Execution",
                    dcc.Dropdown(
                        id="execution-filter",
                        options=options(DEFAULT_EXECUTION_TYPES),
                        value=DEFAULT_EXECUTION_TYPES,
                        multi=True,
                    ),
                ),
                filter_control(
                    "Y-axis min",
                    dcc.Input(
                        id="y-axis-min",
                        type="number",
                        debounce=True,
                        placeholder="auto",
                        style={"height": "36px"},
                    ),
                ),
                filter_control(
                    "Y-axis max",
                    dcc.Input(
                        id="y-axis-max",
                        type="number",
                        debounce=True,
                        placeholder="auto",
                        style={"height": "36px"},
                    ),
                ),
            ],
            style={
                "display": "grid",
                "gridTemplateColumns": "repeat(auto-fit, minmax(220px, 1fr))",
                "gap": "12px",
                "marginTop": "16px",
            },
        ),
        dcc.Tabs(
            [
                dcc.Tab(label="Duration", children=[dcc.Graph(id="duration-chart")]),
                dcc.Tab(label="Execution phases", children=[dcc.Graph(id="phase-timing-chart")]),
                dcc.Tab(
                    label="Request scaling",
                    children=[
                        dcc.Graph(id="auth-request-scaling-chart"),
                        dcc.Graph(id="resource-request-scaling-chart"),
                    ],
                ),
                dcc.Tab(
                    label="Diefficiency",
                    children=[
                        html.Div(
                            [
                                html.P(
                                    "Diefficiency summarizes how continuously a query engine produces answers over time. "
                                    "Higher dief@t means more answers were produced earlier within that time window."
                                ),
                                filter_control(
                                    "Metric",
                                    dcc.RadioItems(
                                        id="diefficiency-metric",
                                        options=diefficiency_options(),
                                        value="medianDief1s",
                                        inline=True,
                                    ),
                                ),
                            ],
                            style={"margin": "12px 0"},
                        ),
                        dcc.Graph(id="diefficiency-chart"),
                        dcc.Graph(id="diefficiency-duration-chart"),
                    ],
                ),
                dcc.Tab(
                    label="Aggregates",
                    children=[
                        dash_table.DataTable(
                            id="aggregate-table",
                            page_size=20,
                            sort_action="native",
                            filter_action="native",
                            style_table={"overflowX": "auto"},
                            style_cell={"fontFamily": "sans-serif", "fontSize": 13, "padding": "6px"},
                        )
                    ],
                ),
                dcc.Tab(
                    label="Validation",
                    children=[
                        html.Pre(
                            id="validation-json",
                            children=__import__("json").dumps(validation, indent=2),
                            style={"whiteSpace": "pre-wrap"},
                        )
                    ],
                ),
            ],
            style={"marginTop": "16px"},
        ),
    ],
    style={"fontFamily": "sans-serif", "margin": "24px"},
)


def filtered_frames(experiments, authorization_modes, execution_types):
    experiments = experiments or []
    authorization_modes = authorization_modes or []
    execution_types = execution_types or []
    aggregate_filter = (
        aggregates_df["experimentName"].isin(experiments)
        & aggregates_df["authorizationMode"].isin(authorization_modes)
        & aggregates_df["executionType"].isin(execution_types)
    )
    summary_filter = (
        summary_df["experimentName"].isin(experiments)
        & summary_df["authorizationMode"].isin(authorization_modes)
        & summary_df["executionType"].isin(execution_types)
    )
    if phase_aggregates_df.empty:
        filtered_phases = phase_aggregates_df.copy()
    else:
        phase_filter = (
            phase_aggregates_df["experimentName"].isin(experiments)
            & phase_aggregates_df["authorizationMode"].isin(authorization_modes)
            & phase_aggregates_df["executionType"].isin(execution_types)
        )
        filtered_phases = phase_aggregates_df[phase_filter].copy()
    filtered_aggregates = aggregates_df[aggregate_filter].copy()
    filtered_summary = summary_df[summary_filter].copy()
    filtered_aggregates["iterationSort"] = filtered_aggregates["iterationArgs"].map(x_sort_key)
    filtered_aggregates["variantSort"] = filtered_aggregates["variant"].map(variant_sort_key)
    filtered_aggregates = filtered_aggregates.sort_values(
        ["experimentName", "authorizationMode", "iterationName", "iterationSort", "variantSort"]
    )
    if not filtered_phases.empty:
        filtered_phases["iterationSort"] = filtered_phases["iterationArgs"].map(x_sort_key)
        filtered_phases["variantSort"] = filtered_phases["variant"].map(variant_sort_key)
        filtered_phases["phaseFacet"] = filtered_phases["experimentName"] + " / " + filtered_phases["variant"]
        filtered_phases = filtered_phases.sort_values(
            ["experimentName", "authorizationMode", "iterationName", "iterationSort", "variantSort", "phaseOrder"]
        )
    return filtered_summary, filtered_aggregates, filtered_phases


@app.callback(
    Output("duration-chart", "figure"),
    Output("phase-timing-chart", "figure"),
    Output("auth-request-scaling-chart", "figure"),
    Output("resource-request-scaling-chart", "figure"),
    Output("diefficiency-chart", "figure"),
    Output("diefficiency-duration-chart", "figure"),
    Output("aggregate-table", "data"),
    Output("aggregate-table", "columns"),
    Input("experiment-filter", "value"),
    Input("authorization-filter", "value"),
    Input("execution-filter", "value"),
    Input("y-axis-min", "value"),
    Input("y-axis-max", "value"),
    Input("diefficiency-metric", "value"),
)
def update_views(experiments, authorization_modes, execution_types, y_min, y_max, diefficiency_metric):
    _, filtered_aggregates, filtered_phases = filtered_frames(
        experiments,
        authorization_modes,
        execution_types,
    )
    facet_authorization_order = [
        value for value in (authorization_modes or []) if value in set(filtered_aggregates["authorizationMode"])
    ]
    variant_order = sorted(filtered_aggregates["variant"].unique(), key=variant_sort_key)
    axis_range = y_axis_range(y_min, y_max)
    duration_figure = px.line(
        filtered_aggregates,
        x="iterationArgs",
        y="medianDurationMs",
        color="variant",
        facet_row="experimentName",
        facet_col="authorizationMode",
        markers=True,
        category_orders={
            "authorizationMode": facet_authorization_order,
            "iterationArgs": sorted(filtered_aggregates["iterationArgs"].unique(), key=x_sort_key),
            "variant": variant_order,
        },
        color_discrete_map=VARIANT_COLORS,
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
        },
    )
    if axis_range is not None:
        duration_figure.update_yaxes(range=axis_range)
    phase_order = []
    if not filtered_phases.empty:
        phase_order = [
            label
            for _, label in sorted(
                {(int(row.phaseOrder), str(row.phaseLabel)) for row in filtered_phases.itertuples()},
                key=lambda item: item,
            )
        ]
    phase_figure = px.bar(
        filtered_phases,
        x="iterationArgs",
        y="medianPhaseDurationMs",
        color="phaseLabel",
        facet_row="phaseFacet" if "phaseFacet" in filtered_phases else None,
        facet_col="authorizationMode",
        category_orders={
            "authorizationMode": facet_authorization_order,
            "iterationArgs": sorted(filtered_phases["iterationArgs"].unique(), key=x_sort_key)
            if not filtered_phases.empty else [],
            "phaseLabel": phase_order,
        },
        hover_data={
            "phaseLabel": True,
            "experimentName": True,
            "authorizationMode": True,
            "iterationName": True,
            "iterationArgs": True,
            "variant": True,
            "runs": True,
            "medianPhaseDurationMs": ":.3f",
            "averagePhaseDurationMs": ":.3f",
            "medianPhaseCumulativeMs": ":.3f",
        },
        labels={
            "iterationArgs": "Iteration argument",
            "medianPhaseDurationMs": "Median phase duration (ms)",
            "phaseLabel": "Phase",
            "phaseFacet": "Experiment / variant",
            "authorizationMode": "Authorization",
            "medianPhaseCumulativeMs": "Median cumulative phase duration (ms)",
        },
    )
    phase_figure.update_layout(barmode="stack")
    if axis_range is not None:
        phase_figure.update_yaxes(range=axis_range)
    auth_request_scaling_figure = px.line(
        filtered_aggregates,
        x="iterationArgs",
        y="medianOverallAuthorizationTokenRequests",
        color="variant",
        facet_row="experimentName",
        facet_col="authorizationMode",
        markers=True,
        category_orders={
            "authorizationMode": facet_authorization_order,
            "iterationArgs": sorted(filtered_aggregates["iterationArgs"].unique(), key=x_sort_key),
            "variant": variant_order,
        },
        color_discrete_map=VARIANT_COLORS,
        hover_data={
            "variant": True,
            "experimentName": True,
            "authorizationMode": True,
            "iterationName": True,
            "iterationArgs": True,
            "runs": True,
            "medianAuthorizationTokenRequests": ":.3f",
            "medianHttpRequests": ":.3f",
            "medianResourceRequests": ":.3f",
            "medianSetupAuthorizationTokenRequests": ":.3f",
            "medianOverallAuthorizationTokenRequests": ":.3f",
            "medianDurationMs": ":.3f",
        },
        labels={
            "iterationArgs": "Iteration argument",
            "medianOverallAuthorizationTokenRequests": "Overall median auth token requests",
            "medianAuthorizationTokenRequests": "Measured median auth token requests",
            "medianHttpRequests": "Measured median HTTP requests",
            "medianResourceRequests": "Measured median resource requests",
            "medianSetupAuthorizationTokenRequests": "Setup median auth token requests",
            "medianDurationMs": "Median duration (ms)",
            "variant": "Variant",
            "authorizationMode": "Authorization",
        },
    )
    resource_request_scaling_figure = px.line(
        filtered_aggregates,
        x="iterationArgs",
        y="medianResourceRequests",
        color="variant",
        facet_row="experimentName",
        facet_col="authorizationMode",
        markers=True,
        category_orders={
            "authorizationMode": facet_authorization_order,
            "iterationArgs": sorted(filtered_aggregates["iterationArgs"].unique(), key=x_sort_key),
            "variant": variant_order,
        },
        color_discrete_map=VARIANT_COLORS,
        hover_data={
            "variant": True,
            "experimentName": True,
            "authorizationMode": True,
            "iterationName": True,
            "iterationArgs": True,
            "runs": True,
            "medianResourceRequests": ":.3f",
            "medianAuthorizationTokenRequests": ":.3f",
            "medianHttpRequests": ":.3f",
            "medianSetupResourceRequests": ":.3f",
            "medianOverallResourceRequests": ":.3f",
            "medianDurationMs": ":.3f",
        },
        labels={
            "iterationArgs": "Iteration argument",
            "medianResourceRequests": "Measured median resource requests",
            "medianAuthorizationTokenRequests": "Measured median auth token requests",
            "medianHttpRequests": "Measured median HTTP requests",
            "medianSetupResourceRequests": "Setup median resource requests",
            "medianOverallResourceRequests": "Overall median resource requests",
            "medianDurationMs": "Median duration (ms)",
            "variant": "Variant",
            "authorizationMode": "Authorization",
        },
    )
    diefficiency_labels = {
        "medianDief100ms": "Median dief@100ms",
        "medianDief1s": "Median dief@1s",
        "medianDief2500ms": "Median dief@2.5s",
        "medianDief4s": "Median dief@4s",
        "medianDief10s": "Median dief@10s",
    }
    diefficiency_figure = px.line(
        filtered_aggregates,
        x="iterationArgs",
        y=diefficiency_metric,
        color="variant",
        facet_row="experimentName",
        facet_col="authorizationMode",
        markers=True,
        category_orders={
            "authorizationMode": facet_authorization_order,
            "iterationArgs": sorted(filtered_aggregates["iterationArgs"].unique(), key=x_sort_key),
            "variant": variant_order,
        },
        color_discrete_map=VARIANT_COLORS,
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
            diefficiency_metric: diefficiency_labels.get(diefficiency_metric, diefficiency_metric),
            "variant": "Variant",
            "authorizationMode": "Authorization",
            "medianDurationMs": "Median duration (ms)",
            "medianHttpRequests": "Median HTTP requests",
            "medianResourceRequests": "Median resource requests",
            "medianAuthorizationTokenRequests": "Median auth token requests",
        },
    )
    diefficiency_duration_figure = px.scatter(
        filtered_aggregates,
        x="medianDurationMs",
        y=diefficiency_metric,
        color="variant",
        symbol="authorizationMode",
        facet_col="experimentName",
        category_orders={
            "authorizationMode": facet_authorization_order,
            "variant": variant_order,
        },
        color_discrete_map=VARIANT_COLORS,
        hover_data={
            "variant": True,
            "authorizationMode": True,
            "iterationName": True,
            "iterationArgs": True,
            "runs": True,
            "medianDurationMs": ":.3f",
            "medianDief100ms": ":.3f",
            "medianDief1s": ":.3f",
            "medianDief2500ms": ":.3f",
            "medianDief4s": ":.3f",
            "medianDief10s": ":.3f",
            "medianHttpRequests": ":.3f",
        },
        labels={
            "medianDurationMs": "Median duration (ms)",
            diefficiency_metric: diefficiency_labels.get(diefficiency_metric, diefficiency_metric),
            "variant": "Variant",
            "authorizationMode": "Authorization",
        },
    )
    if axis_range is not None:
        diefficiency_figure.update_yaxes(range=axis_range)
        diefficiency_duration_figure.update_yaxes(range=axis_range)
    columns = [
        {"name": column, "id": column}
        for column in filtered_aggregates.columns
        if column not in {"iterationSort", "variantSort"}
    ]
    return (
        duration_figure,
        phase_figure,
        auth_request_scaling_figure,
        resource_request_scaling_figure,
        diefficiency_figure,
        diefficiency_duration_figure,
        filtered_aggregates.drop(columns=["iterationSort", "variantSort"]).to_dict("records"),
        columns,
    )


if __name__ == "__main__":
    app.run(debug=False, dev_tools_ui=False, dev_tools_props_check=False, port=8050)
