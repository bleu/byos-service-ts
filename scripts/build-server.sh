#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
exec bash "$repo/scripts/deployment/remote-bootstrap.sh" "$repo" build "$@"
