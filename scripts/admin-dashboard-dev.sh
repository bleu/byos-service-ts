#!/usr/bin/env bash
set -euo pipefail

readonly database_name="byos_dashboard_dev"
readonly database_url="postgres://postgres:postgres@localhost:5432/${database_name}"

docker compose up -d --wait postgres
docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
	-c "DROP DATABASE IF EXISTS ${database_name} WITH (FORCE)"
docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
	-c "CREATE DATABASE ${database_name}"
DATABASE_URL="${database_url}" node --experimental-strip-types apps/admin/scripts/seed-dashboard.ts

echo "Dashboard fixture ready at ${database_url}"
exec env DATABASE_URL="${database_url}" pnpm --filter @byos/admin dev
