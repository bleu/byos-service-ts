# BYOS Service — Project Context

BYOS (Bring Your Own Solver) is a bonded CoW solver whose proposed solutions are sourced from a permissionless set of external sub-solvers. Sub-solvers submit signed routing proposals against specific order UIDs, collateralized by an escrow balance held by BYOS. This repo holds the off-chain service; the on-chain half (Escrow, Trampoline, TrampolineFactory) lives in [`bleu/byos-contracts`](https://github.com/bleu/byos-contracts).

Domain vocabulary and the normative specification are in `docs/shared/` (a Git submodule → [bleu/byos-docs](https://github.com/bleu/byos-docs)). See `docs/shared/glossary.md` for terms, `docs/shared/design-document.md` for the spec, and `apps/byos/openapi.yml` for the API wire contract.

## Components

| Package | What it is |
|---|---|
| `apps/byos` | The BYOS service: proposal API, solver engine, background workers (validation, retention, penalty, audit) |
| `apps/baseline-subsolver` | Baseline reference sub-solver client and e2e-test counterpart |
| `packages/common` | Shared contract ABIs, EIP-712 encoding, DTOs, trampoline encoding |
| `tests/integration` | API integration tests (in-process, no running service needed) |
| `tests/e2e` | End-to-end tests (Anvil + full CoW Protocol stack in Docker) |

Process topology: **one process, two listeners** — a public port for `/proposals` and a firewalled internal port for `/solve` and `/notify`, sharing the Postgres proposal store.

## Service design posture

- BYOS requires **no changes to the CoW auction/competition** — it is a black box to the protocol, a vanilla solver engine to the driver.
- Simulation failures cost the sub-solver **nothing** (rate-limit only); only on-chain failures debit escrow.
- The API is **permissionless + collateral-gated**, not allowlisted — the escrow deposit *is* the permission.
- The escrow contract is a dumb ledger; the service is the brain — reserve calculations, proposal eligibility, gatekeeping, attribution, and dispute handling all live here.
- The `/solve` hot path does no simulation and no RPC — an indexed read of the live proposal rows per auction order, plus one `solutions` insert per returned bid.
