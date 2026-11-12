#!/usr/bin/env bash
set -euo pipefail
exec python3 "$(dirname "$0")/deployment/client.py" pull-secrets "$@"
