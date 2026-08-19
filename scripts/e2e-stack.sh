#!/bin/bash
# Convenience wrapper for the full-stack e2e Docker Compose setup.
#
# Usage:
#   ./scripts/e2e-stack.sh up -d --build --wait
#   ./scripts/e2e-stack.sh down -v
#   ./scripts/e2e-stack.sh logs byos-ts
set -euo pipefail
docker compose -f docker-compose.e2e.yml "$@"
