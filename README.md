# BYOS Service (TypeScript)

A **Bring Your Own Solver** service for [CoW Protocol](https://cow.fi/) — accepts settlement proposals from permissionless external sub-solvers, validates them, and answers the CoW driver's `/solve` auction with the best route per order. TypeScript rewrite of the [Rust BYOS service](https://github.com/bleu/byos-service).

Read [`CONTEXT.md`](CONTEXT.md) for domain language and architecture. Read [`AGENTS.md`](AGENTS.md) for contributor conventions.

## Repo structure

| Path | Description | Status |
|------|-------------|--------|
| `apps/byos` | Main BYOS service (proposal API + solver engine + background jobs) | Complete |
| `apps/subsolver` | Reference sub-solver (Uniswap V2 routing, orderbook polling) | Complete |
| `packages/common` | Shared types: EIP-712, ABIs, DTOs, settlement encoding | Complete |
| `tests/e2e` | API integration tests (proposal lifecycle, /solve, /notify) | Complete |
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
- [`AGENTS.md`](AGENTS.md) — Agent/contributor guidelines, conventions, how to port
- [`docs/adr/`](docs/adr/) — Architecture decision records
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — Migration plan from Rust
- [`docs/reference/`](docs/reference/) — CoW Protocol background
- [`apps/byos/openapi.yml`](apps/byos/openapi.yml) — Proposal API specification

## Related repositories

- [`bleu/byos-service`](https://github.com/bleu/byos-service) — Rust reference implementation
- [`bleu/byos-contracts`](https://github.com/bleu/byos-contracts) — Escrow, Trampoline, TrampolineFactory (Foundry)
- [`cowprotocol/services`](https://github.com/cowprotocol/services) — CoW backend (driver/autopilot)
- [`cowdao-grants/offline-mode`](https://github.com/cowdao-grants/offline-mode) — Offline CoW stack for e2e testing

## License

[GPL-3.0-or-later](LICENSE)
