# ADR-0004: pnpm Monorepo and Tooling

**Status:** Accepted
**Replaces:** Rust ADR-0004 (Cargo Workspace and Tooling)

## Context

The TypeScript BYOS service is a monorepo with two runnable apps and shared packages. We need a workspace manager, build tool, linter/formatter, and test runner.

## Decision

| Concern | Tool | Rationale |
|---------|------|-----------|
| Package manager | pnpm (workspaces) | Fast, disk-efficient, strict dependency resolution |
| Build (apps) | tsup (esbuild) | Fast bundling, ESM output, no config for simple cases |
| Build (packages) | tsc | Produces `.d.ts` declarations for consumers |
| Linter + formatter | Biome | One tool for both, fast (Rust-based), minimal config |
| Test runner | Vitest | Native ESM, workspace support, fast |
| Type checking | `tsc -b` (project references) | Incremental, workspace-aware |

## Workspace layout

```
apps/          → Runnable services (tsup build, no .d.ts)
packages/      → Shared libraries (tsc build, .d.ts for consumers)
tests/         → Integration tests
```

All three are pnpm workspace members via `pnpm-workspace.yaml`.

## Scripts

Root `package.json` scripts orchestrate workspace-wide operations:
- `pnpm build` — builds all packages (tsc) then apps (tsup) in dependency order
- `pnpm test` — Vitest with workspace projects (unit, db, e2e)
- `pnpm lint` — Biome check
- `pnpm typecheck` — `tsc -b` across all project references

## CI

Two GitHub Actions workflows mirroring the Rust repo:
- `lint.yml` — typecheck + biome + OpenAPI spec validation
- `test.yml` — Postgres service + build + unit tests + DB tests
