# BYOS Service

A **Bring Your Own Solver** service for [CoW Protocol](https://cow.fi/) — accepts settlement proposals from permissionless external sub-solvers, validates them, and answers the CoW driver's `/solve` auction with the best route per order.

See [`docs/shared/`](docs/shared/) for the normative BYOS specification, domain glossary, and design document. Read [`CONTEXT.md`](CONTEXT.md) for this implementation's architecture. Read [`AGENTS.md`](AGENTS.md) for contributor conventions.

## Repo structure

| Path | Description | Status |
|------|-------------|--------|
| `apps/byos` | Main BYOS service (proposal API + solver engine + background jobs) | Complete |
| `apps/subsolver` | Reference sub-solver (Uniswap V2 routing, orderbook polling) | Complete |
| `packages/common` | Shared types: EIP-712, ABIs, DTOs, settlement encoding | Complete |
| `tests/e2e` | API integration tests (proposal lifecycle, /solve, /notify) | Complete |
| `tests/full-stack` | Full-stack e2e tests (order → proposal → settlement on Anvil) | Complete |
| `docs/adr` | Architecture decision records (14 ADRs) | Complete |
| `docs/reference` | CoW Protocol background (slashing, auctions, CIPs) | Complete |

## Quick start

### Prerequisites

- Node.js 22+
- pnpm 10+
- Docker (for Postgres + Redis)

### Setup

```bash
# Install dependencies
pnpm install

# Start dev services (Postgres + Redis)
docker compose up -d

# Build all packages
pnpm build

# Run tests
pnpm test
```

### Running the service

```bash
# Copy and edit environment config
cp .env.example .env

# Start the BYOS service
pnpm --filter @byos/byos start
```

The service starts two HTTP listeners:
- **Public API** (port 9585) — sub-solver facing: `/proposals` CRUD
- **Internal API** (port 9586) — driver facing: `/solve`, `/notify`

## Development commands

| Command | Description |
|---------|-------------|
| `pnpm build` | Build all packages and apps |
| `pnpm test` | Run all tests (unit + e2e) |
| `pnpm test:db` | Run database-tier tests only |
| `pnpm lint` | Check code with Biome |
| `pnpm lint:fix` | Auto-fix lint issues |
| `pnpm typecheck` | Type-check with `tsc -b` |
| `pnpm format` | Format code with Biome |
| `pnpm lint:openapi` | Validate OpenAPI spec |
| `pnpm dev` | Start Postgres + run byos in watch mode |
| `pnpm e2e:up` | Start the full e2e stack (Anvil + CoW services + BYOS) |
| `pnpm e2e:down` | Tear down the e2e stack and remove volumes |
| `pnpm test:full-stack` | Run full-stack e2e tests (requires `e2e:up` first) |

### Full-stack e2e tests

The full-stack tests exercise the complete round-trip: GPv2 order submission, BYOS proposal, autopilot auction, driver settlement, and on-chain execution against a local Anvil fork with the full CoW Protocol stack running in Docker.

```bash
# Start the stack (builds Docker images, deploys contracts, waits for healthy)
pnpm e2e:up

# Run the tests
pnpm test:full-stack

# Tear down when done (removes containers + volumes)
pnpm e2e:down
```

To reset the stack (e.g. after contract changes):

```bash
pnpm e2e:down && pnpm e2e:up
```

The e2e stack is defined in [`docker-compose.e2e.yml`](docker-compose.e2e.yml) (BYOS-specific services) layered on top of the [`offline-mode`](https://github.com/bleu/cow-offline-mode) submodule (Anvil chain, orderbook, autopilot, driver). Contract addresses are baked into the Anvil state via [`offline-mode/scripts/byos/deploy-byos-contracts.sh`](offline-mode/scripts/byos/deploy-byos-contracts.sh).

## Technology stack

| Concern | Tool |
|---------|------|
| Runtime | Node.js |
| Web framework | Hono (two apps on separate ports) |
| Database | Drizzle ORM + PostgreSQL |
| Background jobs | BullMQ (Redis) |
| Blockchain | viem |
| Validation | Zod |
| Logging | pino |
| Build | tsup (apps) / tsc (packages) |
| Tests | Vitest |
| Lint + format | Biome |

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list with defaults.

Required:
- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string (default: `redis://localhost:6379`)
- `CHAIN_ID` — Ethereum chain ID for EIP-712 domain
- `TRAMPOLINE_FACTORY` — TrampolineFactory contract address

Optional (enables blockchain validation):
- `RPC_URL` — JSON-RPC endpoint (without this, validation uses AcceptAll)
- `OPERATOR_PRIVATE_KEY` — enables Track A penalty loop

## Architecture

```
Sub-solver → POST /proposals → [Submitted]
                                     ↓ (background validation)
                               [Active] or [Rejected]
                                     ↓
Driver → POST /solve → score proposals → return best solution
Driver → POST /notify → [Settled] / [SettleFailed] / [Active]
```

The service runs three BullMQ background jobs:
1. **Validation** (every 12s) — escrow check + settlement simulation
2. **Retention sweep** (every 5m) — deletes terminal proposals after retention window
3. **Penalty** (every 12s) — Track A escrow debits for reverted settlements

## Documentation

- [`CONTEXT.md`](CONTEXT.md) — Domain glossary, architecture, risk classes
- [`AGENTS.md`](AGENTS.md) — Agent/contributor guidelines and conventions
- [`docs/adr/`](docs/adr/) — Architecture decision records
- [`docs/shared/`](docs/shared/) — Shared BYOS specification (submodule → [bleu/byos-docs](https://github.com/bleu/byos-docs))
- [`apps/byos/openapi.yml`](apps/byos/openapi.yml) — Proposal API specification

## Related repositories

- [`bleu/byos-docs`](https://github.com/bleu/byos-docs) — Shared BYOS specification (submodule at `docs/shared/`)
- [`bleu/byos-contracts`](https://github.com/bleu/byos-contracts) — Escrow, Trampoline, TrampolineFactory (Foundry)
- [`cowprotocol/services`](https://github.com/cowprotocol/services) — CoW backend (driver/autopilot)
- [`cowdao-grants/offline-mode`](https://github.com/cowdao-grants/offline-mode) — Offline CoW stack for e2e testing

## License

[GPL-3.0-or-later](LICENSE)
