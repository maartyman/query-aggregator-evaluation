#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <case-name>" >&2
  exit 2
fi

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CASE="$1"
CASE_DIR="$REPO/tmp/smoke-failed-experiments/$CASE"
CONFIG="$CASE_DIR/config.json"
DATA_ROOT="$CASE_DIR/experiment-data"

mkdir -p "$CASE_DIR" "$DATA_ROOT"

write_config() {
  local experiment_name="$1"
  local experiment_type="$2"
  local authorization_mode="$3"
  local iteration_name="$4"
  local args_json="$5"

  cat > "$CONFIG" <<JSON
{
  "podsPerServer": 30,
  "useExistingData": false,
  "experimentDataRoot": "$DATA_ROOT",
  "resourceRegistrationAuthorizedWebId": "",
  "experiments": {
    "$experiment_name": {
      "type": "$experiment_type",
      "authorizationModes": [ "$authorization_mode" ],
      "iterations": [
        {
          "iterationName": "$iteration_name",
          "args": [
            $args_json
          ]
        }
      ]
    }
  }
}
JSON
}

case "$CASE" in
  wp-overview-nondelegated)
    write_config "wp-overview-smoke" "watchparty-overview-page" "nondelegated" "number-of-joined-watchparties" "[40]"
    ;;
  wp-overview-delegated)
    write_config "wp-overview-smoke" "watchparty-overview-page" "delegated" "number-of-joined-watchparties" "[40]"
    ;;
  wp-messages-nondelegated)
    write_config "wp-messages-smoke" "watchparty-watch-page" "nondelegated" "number-of-members" "[1,10]"
    ;;
  wp-messages-delegated)
    write_config "wp-messages-smoke" "watchparty-watch-page" "delegated" "number-of-members" "[1,10]"
    ;;
  el-fitness-trend-nondelegated)
    write_config "el-fitness-trend-smoke" "elevate-fitness-trend-page" "nondelegated" "activities-count" "[\"complex\", \"fitness-trend\", 1]"
    ;;
  el-fitness-trend-delegated)
    write_config "el-fitness-trend-smoke" "elevate-fitness-trend-page" "delegated" "activities-count" "[\"complex\", \"fitness-trend\", 1]"
    ;;
  *)
    echo "Unknown smoke case: $CASE" >&2
    exit 2
    ;;
esac

cd "$REPO"

if [[ "${REBUILD_PRECOMPILED:-0}" == "1" ]] ||
   [[ ! -f user-managed-access/packages/css/dist/precompiled/app-auth.js ]] ||
   [[ ! -f user-managed-access/packages/uma/dist/precompiled/app-delegated.js ]]; then
  (cd user-managed-access && yarn build:precompiled)
fi

npm run build

WARMUP_RUNS="${WARMUP_RUNS:-0}" \
RECORDED_RUNS="${RECORDED_RUNS:-1}" \
EXPERIMENT_ATTEMPTS="${EXPERIMENT_ATTEMPTS:-1}" \
EXPERIMENT_LOG_LEVEL="${EXPERIMENT_LOG_LEVEL:-warn}" \
timeout "${SMOKE_TIMEOUT:-240s}" node ./dist/main.js --config "$CONFIG"
