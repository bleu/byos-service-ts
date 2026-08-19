#!/bin/bash
# Convenience wrapper for the full-stack e2e Docker Compose setup.
#
# Uses two compose files: the offline-mode base stack + our e2e overlay
# that adds the BYOS service and overrides driver/autopilot config.
#
# Usage:
#   ./scripts/e2e-stack.sh up -d --build --wait
#   ./scripts/e2e-stack.sh down -v
#   ./scripts/e2e-stack.sh logs byos-ts
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# The offline-mode compose references env_file: .env in several services.
# Create it from the example if it doesn't exist.
if [ ! -f "$REPO_ROOT/offline-mode/.env" ]; then
  cp "$REPO_ROOT/offline-mode/.env.example" "$REPO_ROOT/offline-mode/.env"
fi

docker compose \
  -f "$REPO_ROOT/offline-mode/docker-compose.yml" \
  -f "$REPO_ROOT/docker-compose.e2e.yml" \
  "$@"
