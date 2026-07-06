#!/usr/bin/env bash
set -euo pipefail
"$(dirname "${BASH_SOURCE[0]}")/run-smoke.sh" wp-messages-nondelegated
