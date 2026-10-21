
# ADR-0020: EIP-1271 contract sub-solvers

Status: accepted

Spec: docs/shared/design-document.md#proposal-schema
      docs/shared/design-document.md#proposal-api
      https://bleu.github.io/byos-docs/design-document#proposal-schema
      https://bleu.github.io/byos-docs/design-document#proposal-api

> Companion to [`bleu/byos-contracts` PR #42](https://github.com/bleu/byos-contracts/pull/42), which updated `Trampoline._verifySignature` to use OpenZeppelin's `SignatureChecker.isValidSignatureNowCalldata`. That change lets `SUB_SOLVER` be either an EOA or an EIP-1271 contract (e.g. a Gnosis Safe). This ADR records the service-side decisions needed to support contract sub-solvers end-to-end.

## Context

Previously, the Trampoline accepted only EOA sub-solvers: `_verifySignature` recovered the signer via `ecrecover` and required it to equal `SUB_SOLVER`. The service mirrored this: `recoverProposer()` recovers the sub-solver address from the proposal signature using ECDSA. The recovered address is then used as the sub-solver's identity (escrow key and Trampoline CREATE2 salt).

After the contracts change, `SUB_SOLVER` can be a smart contract that implements EIP-1271. The service must verify such signatures before admission.

### Why `subSolverAddress` is a required field for contract signers

For ECDSA: `recoverTypedDataAddress(digest, signature)` is a pure function — no blockchain state needed — that returns the signer's address as output. The service learns the sub-solver address from the signature itself.

For EIP-1271: verification is a forward call — `subSolverAddress.isValidSignature(digest, signature)`. You must know *which contract to call* before you can verify. The signature bytes alone carry no address. There is no equivalent of `ecrecover` that returns a contract address from an EIP-1271 signature.

Consequence: a sub-solver using a contract signer must include a `subSolverAddress` field in the POST body. This is a protocol necessity, not a design choice.

### Why ECDSA is tried first when `subSolverAddress` is declared

When `subSolverAddress` is present, the service first attempts ECDSA recovery. If the recovered address matches the declared address, no RPC call is made — this covers EOA sub-solvers who opt in to declaring their address, and is consistent with what OpenZeppelin's `SignatureChecker` does internally. Only if ECDSA fails does the service fall back to the EIP-1271 on-chain call.

### Why EIP-1271 verification is on the request path

The contract-level check is one `eth_call`. This is cheaper by two orders of magnitude than simulation, and far simpler than deferred verification: if EIP-1271 verification is deferred to the background validator, the service accepts and stores proposals under an unverified identity, and the escrow floor gate and whitelist run against an untrusted address. The latency cost (one `eth_call`, ~50–100 ms) applies only to contract sub-solvers and only when ECDSA does not match. EOA sub-solvers are entirely unaffected.

ADR-0001's "no RPC on the request path" principle was established to keep simulation and escrow RPC calls off the hot path — not to prohibit all RPC. A targeted `eth_call` for contract signature verification is a distinct, narrower case.

### Non-repudiation caveat

When `SUB_SOLVER` is a mutable contract (e.g. a Gnosis Safe with a rotating owner set), the non-repudiation guarantee weakens: the signed calldata is in transaction history, but a sub-solver could change their contract's verification logic after execution and later deny having authorized the route. The service defers any enforcement here (e.g. requiring attestation that the signing contract is non-upgradeable) to v2, consistent with the byos-contracts ADR-0005 note.

## Decision

### API change: optional `subSolverAddress` field

`POST /proposals` gains an optional `subSolverAddress` field (EVM address, hex). Backward compatible: omitting it is the existing behavior.

| `subSolverAddress` absent | `subSolverAddress` present |
|---|---|
| Signature must be exactly 65 bytes | Signature may be 1–4096 bytes |
| ECDSA recovery only | ECDSA attempted first; EIP-1271 as fallback |
| Sub-solver address recovered from signature | Sub-solver address is `subSolverAddress` |

### Verification logic (request path)

```
if subSolverAddress absent:
    subSolver = ecrecover(digest, signature)   // throws → SignatureRecoveryFailed

if subSolverAddress present:
    recovered = ecrecover(digest, signature)   // may throw; OK
    if recovered == subSolverAddress:
        subSolver = subSolverAddress           // EOA fast path, no RPC
    else:
        if verifyEip1271 not configured:
            throw Eip1271NotAvailable
        ok = verifyEip1271(subSolverAddress, digest, signature)  // eth_call
        if ok:
            subSolver = subSolverAddress
        else:
            throw SignatureRecoveryFailed
```

### Injectability

The on-chain EIP-1271 call is injected via `verifyEip1271?: Eip1271Verifier` on `PublicAppContext` (and forwarded to `RoutesConfig`). In production it wraps `publicClient.readContract`. In integration tests it is a mock function. When absent, any proposal that needs EIP-1271 is rejected with `Eip1271NotAvailable` (503-mapped, so clients retry rather than treating it as a permanent failure).

### New error kind: `Eip1271NotAvailable`

Added alongside the existing `Kind` values. HTTP 503. Signals that the service is not configured to verify EIP-1271 signatures — a deployment/configuration issue, not a bad signature. Sub-solvers should retry or contact the operator.

## Alternatives considered

- **Deferred EIP-1271 verification (background validator).** Keeps the request path RPC-free. Rejected: proposal accepted under unverified identity, escrow floor gate and whitelist run against a potentially arbitrary address, and the sub-solver gets no fast rejection — they only learn on the validator tick. The on-chain check is one `eth_call`; the cost asymmetry strongly favors inline.
- **Always declare `subSolverAddress` (break existing API).** Simplifies the code — one path for everyone. Rejected: it's a breaking change with no benefit for EOA sub-solvers.
- **Auto-detect contract via `eth_getCode` before ECDSA.** Check whether `subSolverAddress` has code, then choose the path. Adds an extra RPC call on the hot path even for EOA declarations. Rejected — ECDSA-first is cheaper and covers the EOA case with zero RPC.

## Consequences

- **EOA sub-solvers are unaffected.** The existing ECDSA path is unchanged. No migration.
- **Contract sub-solvers must include `subSolverAddress` in every proposal.** This is the sub-solver's identity for escrow, rate-limiting, and Trampoline CREATE2. It cannot be inferred from an EIP-1271 signature.
- **`verifyEip1271` must be wired in production.** A deployment that omits it cannot serve contract sub-solvers and returns 503 on every such proposal. This is intentional: it forces an explicit deployment decision rather than silently accepting and immediately rejecting proposals.
- **Signature length check is relaxed for `subSolverAddress` proposals.** Anything from 1 to 4096 bytes is accepted; the content is validated by the EIP-1271 contract, not the service.
