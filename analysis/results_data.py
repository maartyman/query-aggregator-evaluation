from __future__ import annotations

import csv
import json
import math
import re
from collections import defaultdict
from pathlib import Path
from statistics import mean, median
from typing import Any, Callable, Iterable

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = ROOT / "results"
OUTPUT_DIR = ROOT / "analysis" / "output"

SUMMARY_COLUMNS = [
    "file",
    "experimentName",
    "authorizationMode",
    "iterationName",
    "iterationArgs",
    "executionType",
    "cacheStrategy",
    "measurementRun",
    "totalResults",
    "timestampCount",
    "totalDuration",
    "dief100ms",
    "dief1s",
    "dief10s",
    "totalHttpRequests",
    "resourceRequests",
    "authorizationTokenRequests",
    "numberOfTriples",
    "setupHttpRequests",
    "setupResourceRequests",
    "setupAuthorizationTokenRequests",
    "setupNumberOfTriples",
    "overallHttpRequests",
    "overallResourceRequests",
    "overallAuthorizationTokenRequests",
    "overallNumberOfTriples",
]

AGGREGATE_COLUMNS = [
    "experimentName",
    "authorizationMode",
    "iterationName",
    "iterationArgs",
    "executionType",
    "cacheStrategy",
    "runs",
    "totalResults",
    "medianDurationMs",
    "averageDurationMs",
    "minDurationMs",
    "maxDurationMs",
    "medianHttpRequests",
    "medianResourceRequests",
    "medianAuthorizationTokenRequests",
    "medianSetupHttpRequests",
    "medianSetupResourceRequests",
    "medianSetupAuthorizationTokenRequests",
    "medianOverallHttpRequests",
    "medianOverallResourceRequests",
    "medianOverallAuthorizationTokenRequests",
    "medianDief100ms",
    "averageDief100ms",
    "medianDief1s",
    "averageDief1s",
    "medianDief10s",
    "averageDief10s",
]

SUMMARY_DATAFRAME_COLUMNS = SUMMARY_COLUMNS + [
    "experimentId",
    "experimentType",
    "warmupRuns",
    "recordedRuns",
]

COMPLEXITY_ORDER = {
    "minimal": 0,
    "simple": 1,
    "normal": 2,
    "complex": 3,
}

AUTHORIZATION_ORDER = ["no-auth", "nondelegated", "delegated"]

AUTHORIZATION_LABELS = {
    "no-auth": "no-auth",
    "nondelegated": "non-delegated",
    "delegated": "delegated",
}

VARIANT_ORDER = [
    ("local", "no-cache"),
    ("local-indexed-cache", "indexed-cache"),
    ("aggregator-discovered", ""),
    ("aggregator", ""),
]

VARIANT_LABELS = {
    ("local", "no-cache"): "Local / no-cache",
    ("local-indexed-cache", "indexed-cache"): "Local / indexed-cache",
    ("aggregator-discovered", ""): "Aggregator discovered",
    ("aggregator", ""): "Aggregator",
}

VARIANT_COLORS = {
    "Local / no-cache": "#4b5563",
    "Local / indexed-cache": "#7c3aed",
    "Aggregator discovered": "#2563eb",
    "Aggregator": "#059669",
}

EXCLUDED_CACHE_STRATEGIES = {"file-cache"}

WP_MESSAGES_EXPERIMENT = "wp-messages-experiment"
WP_PARTICIPANTS_EXPERIMENT = "wp-participants-experiment"


def infer_authorization_mode(file_name: str) -> str:
    match = re.search(r"-(no-auth|nondelegated|delegated)\.json$", file_name)
    return match.group(1) if match else ""


def infer_experiment_name(file_name: str) -> str:
    match = re.search(r"-(no-auth|nondelegated|delegated)\.json$", file_name)
    return file_name[: match.start()] if match else ""


def infer_iteration_args(experiment_id: str) -> str:
    marker = "_query-user"
    if marker not in experiment_id:
        return ""
    prefix = experiment_id.split(marker, 1)[0]
    return prefix.split("-", 1)[1] if "-" in prefix else prefix


def infer_execution_type(experiment_id: str) -> str:
    if "_aggregator_discovered" in experiment_id:
        return "aggregator-discovered"
    if "_aggregator" in experiment_id:
        return "aggregator"
    if experiment_id.endswith("_indexed-cache"):
        return "local-indexed-cache"
    return "local"


def infer_run(file_name: str) -> int:
    match = re.search(r"_run-(\d+)", file_name)
    return int(match.group(1)) if match else 0


def number(value: Any, default: float = 0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalized_cache_strategy(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return str(value)


def authorization_sort_key(value: str) -> tuple[int, str]:
    if value in AUTHORIZATION_ORDER:
        return AUTHORIZATION_ORDER.index(value), value
    return len(AUTHORIZATION_ORDER), value


def authorization_label(value: str) -> str:
    return AUTHORIZATION_LABELS.get(value, value or "-")


def variant_label(execution_type: object, cache_strategy: object) -> str:
    key = (str(execution_type), normalized_cache_strategy(cache_strategy))
    if key in VARIANT_LABELS:
        return VARIANT_LABELS[key]
    cache = key[1] or "-"
    return f"{key[0]} / {cache}"


def variant_sort_key(value: str) -> tuple[int, str]:
    ordered_labels = [VARIANT_LABELS[key] for key in VARIANT_ORDER]
    if value in ordered_labels:
        return ordered_labels.index(value), value
    return len(ordered_labels), value


def split_pair_iteration_arg(value: object, index: int) -> str:
    parts = str(value or "").split("_")
    if len(parts) != 2:
        return str(value or "")
    return parts[index]


def normalize_experiment_fields(row: dict[str, Any]) -> dict[str, Any]:
    if row.get("experimentName") != WP_MESSAGES_EXPERIMENT:
        return row

    if row.get("iterationName") == "number-of-members":
        row["experimentName"] = WP_PARTICIPANTS_EXPERIMENT
        row["iterationName"] = "number-of-participants"
        row["iterationArgs"] = split_pair_iteration_arg(row.get("iterationArgs"), 0)
    elif row.get("iterationName") == "number-of-messages":
        row["iterationArgs"] = split_pair_iteration_arg(row.get("iterationArgs"), 1)

    return row


def normalize_frame(df: pd.DataFrame) -> pd.DataFrame:
    normalized = df.copy()
    if "cacheStrategy" in normalized:
        normalized = normalized[~normalized["cacheStrategy"].isin(EXCLUDED_CACHE_STRATEGIES)].copy()
    if {"experimentName", "iterationName", "iterationArgs"}.issubset(normalized.columns):
        participant_mask = (
            (normalized["experimentName"] == WP_MESSAGES_EXPERIMENT)
            & (normalized["iterationName"] == "number-of-members")
        )
        normalized.loc[participant_mask, "experimentName"] = WP_PARTICIPANTS_EXPERIMENT
        normalized.loc[participant_mask, "iterationName"] = "number-of-participants"
        normalized.loc[participant_mask, "iterationArgs"] = normalized.loc[participant_mask, "iterationArgs"].map(
            lambda value: split_pair_iteration_arg(value, 0)
        )

        message_mask = (
            (normalized["experimentName"] == WP_MESSAGES_EXPERIMENT)
            & (normalized["iterationName"] == "number-of-messages")
        )
        normalized.loc[message_mask, "iterationArgs"] = normalized.loc[message_mask, "iterationArgs"].map(
            lambda value: split_pair_iteration_arg(value, 1)
        )

    if "cacheStrategy" in normalized:
        normalized["cacheStrategy"] = normalized["cacheStrategy"].map(normalized_cache_strategy)
    if "iterationArgs" in normalized:
        normalized["iterationArgs"] = normalized["iterationArgs"].fillna("").astype(str)
    if {"executionType", "cacheStrategy"}.issubset(normalized.columns):
        normalized["variant"] = normalized.apply(
            lambda row: variant_label(row["executionType"], row["cacheStrategy"]),
            axis=1,
        )
    return normalized


def load_results(results_dir: Path = RESULTS_DIR) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in sorted(results_dir.glob("*.json")):
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        parameters = data.get("parameters") or {}
        if parameters.get("cacheStrategy") in EXCLUDED_CACHE_STRATEGIES:
            continue
        file_name = path.name
        if data.get("experimentId", "").endswith("_file-cache"):
            continue
        rows.append(
            normalize_experiment_fields({
                "file": file_name,
                "experimentId": data.get("experimentId", ""),
                "totalDuration": number(data.get("totalDuration")),
                "dief100ms": number(data.get("dief100ms")),
                "dief1s": number(data.get("dief1s")),
                "dief10s": number(data.get("dief10s")),
                "totalResults": int(number(data.get("totalResults"))),
                "timestampCount": len(data.get("timestamps") or []),
                "experimentName": parameters.get("experimentName") or infer_experiment_name(file_name),
                "experimentType": parameters.get("experimentType", ""),
                "authorizationMode": parameters.get("authorizationMode") or infer_authorization_mode(file_name),
                "iterationName": parameters.get("iterationName", ""),
                "iterationArgs": parameters.get("iterationArgs") or infer_iteration_args(data.get("experimentId", "")),
                "executionType": parameters.get("executionType") or infer_execution_type(data.get("experimentId", "")),
                "cacheStrategy": parameters.get("cacheStrategy", ""),
                "measurementRun": int(number(parameters.get("measurementRun") or infer_run(file_name))),
                "totalHttpRequests": int(number(parameters.get("totalHttpRequests", parameters.get("totalHTTPRequests", 0)))),
                "resourceRequests": int(number(parameters.get("resourceRequests", 0))),
                "authorizationTokenRequests": int(number(parameters.get("authorizationTokenRequests", 0))),
                "numberOfTriples": int(number(parameters.get("numberOfTriples", 0))),
                "setupHttpRequests": int(number(parameters.get("setupHttpRequests", parameters.get("setupHTTPRequests", 0)))),
                "setupResourceRequests": int(number(parameters.get("setupResourceRequests", 0))),
                "setupAuthorizationTokenRequests": int(number(parameters.get("setupAuthorizationTokenRequests", 0))),
                "setupNumberOfTriples": int(number(parameters.get("setupNumberOfTriples", 0))),
                "overallHttpRequests": int(number(
                    parameters.get(
                        "overallHttpRequests",
                        parameters.get(
                            "overallHTTPRequests",
                            parameters.get("totalHttpRequests", parameters.get("totalHTTPRequests", 0)),
                        ),
                    )
                )),
                "overallResourceRequests": int(number(parameters.get("overallResourceRequests", parameters.get("resourceRequests", 0)))),
                "overallAuthorizationTokenRequests": int(number(parameters.get("overallAuthorizationTokenRequests", parameters.get("authorizationTokenRequests", 0)))),
                "overallNumberOfTriples": int(number(parameters.get("overallNumberOfTriples", parameters.get("numberOfTriples", 0)))),
                "warmupRuns": int(number(parameters.get("warmupRuns", 0))),
                "recordedRuns": int(number(parameters.get("recordedRuns", 0))),
            })
        )
    return rows


def group_by(items: Iterable[dict[str, Any]], key_fn: Callable[[dict[str, Any]], Any]) -> dict[Any, list[dict[str, Any]]]:
    grouped: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        grouped[key_fn(item)].append(item)
    return grouped


def variant_key(row: dict[str, Any]) -> str:
    return f"{row['executionType']}|{row['cacheStrategy'] or '-'}"


def comparable_run_key(row: dict[str, Any]) -> tuple[Any, ...]:
    return (
        row["experimentName"],
        row["authorizationMode"],
        row["iterationName"],
        row["iterationArgs"],
        row["measurementRun"],
    )


def stable_variant_key(row: dict[str, Any]) -> tuple[Any, ...]:
    return (
        row["experimentName"],
        row["authorizationMode"],
        row["iterationName"],
        row["iterationArgs"],
        variant_key(row),
    )


def validate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    comparable_mismatches = []
    for key, group in group_by(rows, comparable_run_key).items():
        counts: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for row in group:
            counts[row["totalResults"]].append(
                {
                    "file": row["file"],
                    "variant": variant_key(row),
                    "totalResults": row["totalResults"],
                }
            )
        if len(counts) > 1:
            comparable_mismatches.append(
                {
                    "key": "|".join(map(str, key)),
                    "counts": {str(count): values for count, values in counts.items()},
                }
            )

    unstable_variants = []
    for key, group in group_by(rows, stable_variant_key).items():
        counts = sorted({row["totalResults"] for row in group})
        if len(counts) > 1:
            unstable_variants.append(
                {
                    "key": "|".join(map(str, key)),
                    "counts": counts,
                    "files": [
                        {
                            "file": row["file"],
                            "measurementRun": row["measurementRun"],
                            "totalResults": row["totalResults"],
                        }
                        for row in group
                    ],
                }
            )

    timestamp_mismatches = [
        {
            "file": row["file"],
            "totalResults": row["totalResults"],
            "timestampCount": row["timestampCount"],
        }
        for row in rows
        if row["timestampCount"] != row["totalResults"]
    ]

    ok = not comparable_mismatches and not unstable_variants and not timestamp_mismatches
    return {
        "ok": ok,
        "totals": {
            "files": len(rows),
            "comparableMismatches": len(comparable_mismatches),
            "unstableVariants": len(unstable_variants),
            "timestampMismatches": len(timestamp_mismatches),
        },
        "comparableMismatches": comparable_mismatches,
        "unstableVariants": unstable_variants,
        "timestampMismatches": timestamp_mismatches,
    }


def aggregate_key(row: dict[str, Any]) -> tuple[Any, ...]:
    return (
        row["experimentName"],
        row["authorizationMode"],
        row["iterationName"],
        row["iterationArgs"],
        row["executionType"],
        row["cacheStrategy"],
    )


def aggregate(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    aggregates = []
    for _, group in group_by(rows, aggregate_key).items():
        sample = group[0]
        durations = [row["totalDuration"] for row in group]
        result_counts = sorted({row["totalResults"] for row in group})
        aggregates.append(
            {
                "experimentName": sample["experimentName"],
                "authorizationMode": sample["authorizationMode"],
                "iterationName": sample["iterationName"],
                "iterationArgs": sample["iterationArgs"],
                "executionType": sample["executionType"],
                "cacheStrategy": sample["cacheStrategy"],
                "runs": len(group),
                "totalResults": "|".join(map(str, result_counts)),
                "medianDurationMs": round(median(durations), 3),
                "averageDurationMs": round(mean(durations), 3),
                "minDurationMs": round(min(durations), 3),
                "maxDurationMs": round(max(durations), 3),
                "medianHttpRequests": round(median(row["totalHttpRequests"] for row in group), 3),
                "medianResourceRequests": round(median(row["resourceRequests"] for row in group), 3),
                "medianAuthorizationTokenRequests": round(median(row["authorizationTokenRequests"] for row in group), 3),
                "medianSetupHttpRequests": round(median(row["setupHttpRequests"] for row in group), 3),
                "medianSetupResourceRequests": round(median(row["setupResourceRequests"] for row in group), 3),
                "medianSetupAuthorizationTokenRequests": round(
                    median(row["setupAuthorizationTokenRequests"] for row in group), 3
                ),
                "medianOverallHttpRequests": round(median(row["overallHttpRequests"] for row in group), 3),
                "medianOverallResourceRequests": round(median(row["overallResourceRequests"] for row in group), 3),
                "medianOverallAuthorizationTokenRequests": round(
                    median(row["overallAuthorizationTokenRequests"] for row in group), 3
                ),
                "medianDief100ms": round(median(row["dief100ms"] for row in group), 3),
                "averageDief100ms": round(mean(row["dief100ms"] for row in group), 3),
                "medianDief1s": round(median(row["dief1s"] for row in group), 3),
                "averageDief1s": round(mean(row["dief1s"] for row in group), 3),
                "medianDief10s": round(median(row["dief10s"] for row in group), 3),
                "averageDief10s": round(mean(row["dief10s"] for row in group), 3),
            }
        )
    return sorted(
        aggregates,
        key=lambda row: tuple(
            str(row[column])
            for column in [
                "experimentName",
                "authorizationMode",
                "iterationArgs",
                "executionType",
                "cacheStrategy",
            ]
        ),
    )


def load_dataframes(results_dir: Path = RESULTS_DIR) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    rows = load_results(results_dir)
    summary_df = normalize_frame(pd.DataFrame(rows, columns=SUMMARY_DATAFRAME_COLUMNS))
    aggregates_df = normalize_frame(pd.DataFrame(aggregate(rows), columns=AGGREGATE_COLUMNS))
    validation = validate(rows)
    return summary_df, aggregates_df, validation


def load_or_build_dataframes(results_dir: Path = RESULTS_DIR, output_dir: Path = OUTPUT_DIR) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    summary_path = output_dir / "summary.csv"
    aggregates_path = output_dir / "aggregates.csv"
    validation_path = output_dir / "validation.json"

    if summary_path.exists() and aggregates_path.exists() and validation_path.exists():
        raw_summary_df = pd.read_csv(summary_path)
        raw_aggregates_df = pd.read_csv(aggregates_path)
        if (
            ("cacheStrategy" in raw_summary_df and raw_summary_df["cacheStrategy"].isin(EXCLUDED_CACHE_STRATEGIES).any())
            or ("cacheStrategy" in raw_aggregates_df and raw_aggregates_df["cacheStrategy"].isin(EXCLUDED_CACHE_STRATEGIES).any())
        ):
            summary_df, aggregates_df, validation = write_outputs(results_dir, output_dir)
            return summary_df, aggregates_df, validation

        summary_df = normalize_frame(raw_summary_df)
        aggregates_df = normalize_frame(raw_aggregates_df)
        validation = json.loads(validation_path.read_text(encoding="utf-8"))
        if all(column in aggregates_df.columns for column in AGGREGATE_COLUMNS):
            return summary_df, aggregates_df, validation
        summary_df, aggregates_df, validation = write_outputs(results_dir, output_dir)
        return summary_df, aggregates_df, validation

    return load_dataframes(results_dir)


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def write_outputs(results_dir: Path = RESULTS_DIR, output_dir: Path = OUTPUT_DIR) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    rows = load_results(results_dir)
    aggregates = aggregate(rows)
    validation = validate(rows)

    output_dir.mkdir(parents=True, exist_ok=True)
    write_csv(output_dir / "summary.csv", rows, SUMMARY_COLUMNS)
    write_csv(output_dir / "aggregates.csv", aggregates, AGGREGATE_COLUMNS)
    (output_dir / "validation.json").write_text(json.dumps(validation, indent=2) + "\n", encoding="utf-8")
    return (
        normalize_frame(pd.DataFrame(rows, columns=SUMMARY_DATAFRAME_COLUMNS)),
        normalize_frame(pd.DataFrame(aggregates, columns=AGGREGATE_COLUMNS)),
        validation,
    )


def x_sort_key(iteration_args: str) -> tuple[int, object]:
    if iteration_args in COMPLEXITY_ORDER:
        return 0, COMPLEXITY_ORDER[iteration_args]

    numeric_suffix = re.search(r"(-?\d+(?:\.\d+)?)$", str(iteration_args))
    if numeric_suffix:
        raw = numeric_suffix.group(1)
        value = float(raw)
        return 1, int(value) if value.is_integer() else value

    return 2, str(iteration_args)
