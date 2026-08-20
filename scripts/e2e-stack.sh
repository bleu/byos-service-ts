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

# Initialize the services submodule if needed (required for Rust builds + Flyway migrations).
if [ ! -f "$REPO_ROOT/offline-mode/modules/services/Cargo.toml" ]; then
  echo "Initializing offline-mode/modules/services submodule..."
  git -C "$REPO_ROOT/offline-mode" submodule update --init modules/services
fi

# Only the services needed for e2e tests. Excludes frontend, explorer,
# grafana, prometheus, tempo, adminer, watch-tower which need additional
# submodules or are not relevant.
E2E_SERVICES=(
  chain-deployer
  chain
  db
  db-migrations
  coingecko-mock
  orderbook
  autopilot
  driver
  baseline
  byos-db
  byos-redis
  byos-ts
)

compose() {
  docker compose \
    -f "$REPO_ROOT/offline-mode/docker-compose.yml" \
    -f "$REPO_ROOT/docker-compose.e2e.yml" \
    "$@"
}

# If the command is "up", append the service list so we only build/start what's needed.
# For other commands (down, logs, ps, etc.), pass through as-is.
if [ "${1:-}" = "up" ]; then
  # db-migrations is a one-shot Flyway container that exits after running.
  # --wait treats any exited container (even exit 0) as a failure, so we
  # exclude it from the wait and let it run to completion on its own.
  compose "$@" "${E2E_SERVICES[@]}" || {
    # Tolerate exit code 1 when db-migrations exited successfully
    if docker inspect offline-mode-db-migrations-1 --format='{{.State.ExitCode}}' 2>/dev/null | grep -q '^0$'; then
      exit 0
    fi
    exit 1
  }
else
  compose "$@"
fi
