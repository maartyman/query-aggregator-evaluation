from __future__ import annotations

import math
import os
import re
from pathlib import Path
from statistics import median

os.environ.setdefault("MPLCONFIGDIR", "/tmp/matplotlib")

import matplotlib.pyplot as plt
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
SUMMARY_PATH = ROOT / "analysis" / "output" / "summary.csv"
OUTPUT_DIR = ROOT / "analysis" / "output" / "line-plots"

VARIANT_ORDER = [
    ("local", "no-cache"),
    ("local", "file-cache"),
    ("local-indexed-cache", "indexed-cache"),
    ("aggregator-discovered", ""),
    ("aggregator", ""),
]

VARIANT_LABELS = {
    ("local", "no-cache"): "Local",
    ("local", "file-cache"): "Local + file cache",
    ("local-indexed-cache", "indexed-cache"): "Local + indexed cache",
    ("aggregator-discovered", ""): "Aggregator discovery",
    ("aggregator", ""): "Aggregator",
}

VARIANT_STYLES = {
    ("local", "no-cache"): {"color": "#4b5563", "marker": "o"},
    ("local", "file-cache"): {"color": "#d97706", "marker": "s"},
    ("local-indexed-cache", "indexed-cache"): {"color": "#7c3aed", "marker": "^"},
    ("aggregator-discovered", ""): {"color": "#2563eb", "marker": "D"},
    ("aggregator", ""): {"color": "#059669", "marker": "X"},
}

COMPLEXITY_ORDER = {
    "minimal": 0,
    "simple": 1,
    "normal": 2,
    "complex": 3,
}


def normalized_cache_strategy(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return str(value)


def variant_key(row: pd.Series) -> tuple[str, str]:
    return str(row["executionType"]), normalized_cache_strategy(row["cacheStrategy"])


def x_sort_key(iteration_args: str) -> tuple[int, object]:
    if iteration_args in COMPLEXITY_ORDER:
        return 0, COMPLEXITY_ORDER[iteration_args]

    numeric_suffix = re.search(r"(-?\d+(?:\.\d+)?)$", iteration_args)
    if numeric_suffix:
        raw = numeric_suffix.group(1)
        number = float(raw)
        return 1, int(number) if number.is_integer() else number

    return 2, iteration_args


def x_label(iteration_args: str) -> str:
    if iteration_args in COMPLEXITY_ORDER:
        return iteration_args

    numeric_suffix = re.search(r"(-?\d+(?:\.\d+)?)$", iteration_args)
    if numeric_suffix:
        return numeric_suffix.group(1)

    return iteration_args


def safe_file_name(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "_", value).strip("_")


def load_summary() -> pd.DataFrame:
    if not SUMMARY_PATH.exists():
        raise FileNotFoundError(
            f"{SUMMARY_PATH} does not exist. Run analysis/analyze-results.ipynb first."
        )

    df = pd.read_csv(SUMMARY_PATH)
    df["cacheStrategy"] = df["cacheStrategy"].map(normalized_cache_strategy)
    return df


def aggregate_for_lines(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    grouped = df.groupby(
        [
            "experimentName",
            "authorizationMode",
            "iterationName",
            "iterationArgs",
            "executionType",
            "cacheStrategy",
        ],
        dropna=False,
    )

    for key, group in grouped:
        (
            experiment_name,
            authorization_mode,
            iteration_name,
            iteration_args,
            execution_type,
            cache_strategy,
        ) = key
        durations = [float(value) for value in group["totalDuration"]]
        rows.append(
            {
                "experimentName": experiment_name,
                "authorizationMode": authorization_mode,
                "iterationName": iteration_name,
                "iterationArgs": str(iteration_args),
                "executionType": execution_type,
                "cacheStrategy": normalized_cache_strategy(cache_strategy),
                "medianDurationMs": median(durations),
                "runs": len(durations),
            }
        )

    return pd.DataFrame(rows)


def plot_group(group: pd.DataFrame, output_path: Path) -> None:
    x_values = sorted(group["iterationArgs"].unique(), key=x_sort_key)
    positions = list(range(len(x_values)))
    position_by_arg = {value: index for index, value in enumerate(x_values)}

    fig, ax = plt.subplots(figsize=(9.5, 5.4))

    for variant in VARIANT_ORDER:
        variant_rows = group[
            (group["executionType"] == variant[0]) &
            (group["cacheStrategy"] == variant[1])
        ].copy()
        if variant_rows.empty:
            continue

        variant_rows["xPosition"] = variant_rows["iterationArgs"].map(position_by_arg)
        variant_rows = variant_rows.sort_values("xPosition")
        style = VARIANT_STYLES[variant]
        ax.plot(
            variant_rows["xPosition"],
            variant_rows["medianDurationMs"],
            label=VARIANT_LABELS[variant],
            linewidth=2,
            markersize=5,
            **style,
        )

    experiment_name = str(group["experimentName"].iloc[0])
    authorization_mode = str(group["authorizationMode"].iloc[0])
    iteration_name = str(group["iterationName"].iloc[0])
    ax.set_title(f"{experiment_name}: {iteration_name} ({authorization_mode})")
    ax.set_xlabel(iteration_name)
    ax.set_ylabel("median duration (ms)")
    ax.set_xticks(positions)
    ax.set_xticklabels([x_label(value) for value in x_values])
    ax.grid(axis="y", color="#d1d5db", linewidth=0.8)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.legend(loc="best", frameon=False)
    fig.tight_layout()
    fig.savefig(output_path)
    plt.close(fig)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for existing_plot in OUTPUT_DIR.glob("*.svg"):
        existing_plot.unlink()

    df = load_summary()
    aggregates = aggregate_for_lines(df)

    written = []
    for (experiment_name, authorization_mode, iteration_name), group in aggregates.groupby(
        ["experimentName", "authorizationMode", "iterationName"],
        sort=True,
    ):
        output_path = OUTPUT_DIR / (
            f"{safe_file_name(experiment_name)}__"
            f"{safe_file_name(authorization_mode)}__"
            f"{safe_file_name(iteration_name)}.svg"
        )
        plot_group(group, output_path)
        written.append(output_path)

    print(f"Wrote {len(written)} line plots to {OUTPUT_DIR}")
    for path in written:
        print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
