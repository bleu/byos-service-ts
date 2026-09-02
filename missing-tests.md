# Missing Tests

Cross-repository coverage analysis across `byos-docs`, `byos-contracts`, and `byos-service-ts`.

**Legend — test types (cheapest first):** `unit` → `db` → `integration` → `e2e` → `contract`  
(`contract` = Foundry/Hardhat test on deployed contracts; treated as equivalent to integration cost but placed separately because it lives in `byos-contracts`)

---

## Buffer Accounting & Loose Slippage

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-service-ts | Under-delivery creates a positive buffer entry | On `Settled` notification where `delta < quoteBuyAmount`, assert a `buffer_entries` row is inserted with `amount = quoteBuyAmount − delta` (in native token at reference price) | unit |
| byos-service-ts | Over-delivery creates a negative (credit) buffer entry | On `Settled` notification where `delta > quoteBuyAmount`, assert a `buffer_entries` row is inserted with a negative amount | unit |
| byos-service-ts | Positive and negative buffer entries net against each other | Penalty job with mixed-sign entries whose sum < `c_l` → no `debit()` call is made | unit |
| byos-service-ts | Buffer debit not triggered when net balance is below `c_l` | Single positive entry below threshold → penalty job tick → assert `debit()` not called | unit |
| byos-service-ts | Buffer debit triggered (full balance) when net balance exceeds `c_l` | Cumulative entries summing above `c_l` → penalty job tick → assert single `debit(subSolver, netBalance, keccak(subSolver))` call | unit |
| byos-service-ts | Loose-slippage settlement writes buffer entry to DB | Integration: submit proposal with `minBuyAmount < quoteBuyAmount`, POST `/notify` with `Settled` result and `delta < quoteBuyAmount` → query `buffer_entries` table and assert row exists | integration |
| byos-service-ts | Over-delivery followed by under-delivery stays below `c_l` and avoids debit | Integration: two proposals for same sub-solver — first over-delivers (credit), second under-delivers (debit), net < `c_l` → no escrow debit | integration |

---

## Order Validation — `minBuyAmount` / `quoteBuyAmount` Constraints

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-service-ts | Buy order rejects `minBuyAmount ≠ quoteBuyAmount` | Unit in `order.test.ts`: build a buy-order proposal with `minBuyAmount < quoteBuyAmount` → expect validation error | unit |
| byos-service-ts | Sell order rejects `minBuyAmount < order.buyAmount` | Unit: proposal where `minBuyAmount` undershoots the order's limit → expect validation error | unit |
| byos-service-ts | Sell order rejects `quoteBuyAmount < minBuyAmount` | Unit: proposal with inverted floor/ceiling → expect validation error | unit |
| byos-service-ts | Partially-fillable sell order accepts proportionally scaled `minBuyAmount < quoteBuyAmount` | Unit: partial-fill sell order where amounts satisfy limit-price check after scaling → expect validation pass | unit |
| byos-service-ts | Same-token hook order (`sellToken == buyToken`) passes envelope validation | Unit: order with equal token addresses and `sellAmount > buyAmount` → expect validation pass | unit |

---

## Validation Lifecycle Edge Cases

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-service-ts | Profitability gate applies on first simulation only | Unit (validator): proposal scores ≤ 0 on first sim → `SimFailed`; same proposal already `Active` with score ≤ 0 on re-sim → stays `Active` | unit |
| byos-service-ts | Re-validation escrow re-check transitions `Active` → `Rejected` if balance drops | Integration: proposal is `Active`; mock escrow balance to drop below floor; trigger validation tick → assert proposal status = `Rejected` | integration |
| byos-service-ts | Validation loop transitions `Active` → `Expired` when `validUntil` passes | Integration: `Active` proposal whose `validUntil` is in the past; run validation tick → assert status = `Expired`, no penalty queued | integration |
| byos-service-ts | `Executing` timeout (>5 min) returns proposal to `Active` without debit | Integration: proposal transitions to `Executing`; advance clock past 5 min; run validation tick → assert status = `Active`, no entry in `penalties` table | integration |
| byos-service-ts | Validation rejects proposal whose order is no longer live (filled/cancelled/expired on orderbook) | Unit (validator): order mock returns `filled` → proposal transitions to `Rejected` with appropriate reason | unit |

---

## Settlement Outcomes & Notifications

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-service-ts | `Cancelled`/`Expired`/`Fail` on `Executing` proposal queues non-settlement debit | Integration: POST `/notify` with `Cancelled` outcome on an `Executing` proposal → assert entry in `penalties` table with amount = `0.1 × c_l` | integration |
| byos-service-ts | Missing `/notify` for an `Executing` proposal does not cause incorrect debit | Integration: no notification received within executing timeout → proposal returns to `Active`; assert no penalty row created | integration |
| byos-service-ts | `Success` notification with over-delivery stores negative buffer entry (credit) | Integration: POST `/notify` with `Settled` and `delta > quoteBuyAmount` → assert negative buffer entry | integration |

---

## Solver Engine & Settlement Crafting

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-service-ts | Proposal excluded from `/solve` if gas cut drops user below signed limit price | Unit (solver): construct proposal where `gasInSellToken` would push effective output below `quoteBuyAmount` limit → assert proposal not returned | unit |
| byos-service-ts | `/solve` response sets `SolutionMerging` to `Forbidden` | Unit or integration: call `/solve` with a winning proposal → assert top-level `merging: "Forbidden"` field in response | unit |
| byos-service-ts | Settlement crafting produces exactly two interactions per proposal | Unit: given proposal + interactions, assert encoded solution has exactly `[transfer(trampoline, sellAmount), execute(...)]` and no extras | unit |
| byos-service-ts | Trampoline CREATE2 address computed locally without RPC | Unit (`common/trampoline`): given sub-solver address + factory, assert `computeAddress()` matches expected deterministic address; no provider call | unit |
| byos-service-ts | Gas cut declared as `fee` field, not subtracted from `sellAmount` | Integration: `/solve` response for a proposal → assert `sellAmount` unchanged and `fee` field equals gas cost in sell-token | integration |

---

## Security & Access Control

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-service-ts | Non-owner proposal read returns `404`, not `403` | Integration: sub-solver A authenticates and GETs a proposal belonging to sub-solver B → assert `404` | integration |
| byos-service-ts | Proposal submission from sub-solver below escrow floor is rejected (`402`/`403`) at submission, not deferred to validation | Integration: submit from address with zero escrow → expect synchronous rejection with reason `insufficient_escrow` | integration |
| byos-service-ts | Cancellation with wrong signer is rejected | Integration: sub-solver B sends DELETE for sub-solver A's proposal → assert `404` or `403` | integration |

---

## Escrow Lifecycle — Withdrawal Cooldown

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-contracts | `effectiveBalance` returns 0 immediately after `requestWithdrawal` | `requestWithdrawal()` → `effectiveBalance(subSolver)` → assert `0` | contract |
| byos-contracts | `executeWithdrawal` reverts before cooldown period expires | `requestWithdrawal()` → immediately `executeWithdrawal()` → assert revert | contract |
| byos-contracts | Debit during cooldown reduces the amount received on `executeWithdrawal` | `requestWithdrawal()` → `debit(X)` → advance past cooldown → `executeWithdrawal()` → assert received = `balance - X` | contract |
| byos-contracts | `cancelWithdrawal` restores `effectiveBalance` (callable even during freeze/pause) | `requestWithdrawal()` → `freeze()` or `pause()` → `cancelWithdrawal()` succeeds → `effectiveBalance` = full balance | contract |
| byos-service-ts | Sub-solver with pending withdrawal has proposals rejected at validation | Integration: sub-solver calls `requestWithdrawal()` on chain; run validation tick → `Active` proposal transitions to `Rejected` (effective balance = 0) | integration |

---

## Escrow Lifecycle — Freeze & Pause

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-contracts | Freeze blocks `executeWithdrawal` but does **not** affect `effectiveBalance` | `freeze(sub)` → `executeWithdrawal()` reverts; `effectiveBalance(sub)` returns full balance (not zero) | contract |
| byos-contracts | Freeze blocks ERC20 `transfer` from frozen sender | `freeze(sub)` → `transfer(other, amount)` from `sub` → revert | contract |
| byos-contracts | Freeze blocks ERC20 `transfer` to frozen receiver | `freeze(receiver)` → transfer to `receiver` → revert | contract |
| byos-contracts | ERC20 `transfer` blocked if sender has a pending withdrawal | `requestWithdrawal()` → `transfer()` → revert | contract |
| byos-contracts | ERC20 `transfer` to new address deploys Trampoline for receiver | `transfer(newAddress, amount)` → assert `factory.addressOf(newAddress)` has deployed code | contract |
| byos-contracts | Pause blocks transfers and `executeWithdrawal` but allows deposits and debits | `pause()` → `transfer` reverts; `deposit()` succeeds; `debit()` succeeds; `executeWithdrawal` reverts | contract |
| byos-contracts | `unfreeze` after freeze allows withdrawal without restarting cooldown | `requestWithdrawal()` → `freeze()` → advance past cooldown → `unfreeze()` → `executeWithdrawal()` succeeds | contract |

---

## Escrow Invariant

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-contracts | `totalSupply() + accumulatedDebits == address(this).balance` holds after any sequence of operations | Fuzz: sequence of `deposit`, `debit`, `requestWithdrawal`, `executeWithdrawal` calls → assert invariant after each step | contract |

---

## On-Chain Trampoline Enforcement

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-contracts | Nonce reuse reverts with `NonceAlreadyUsed` | Execute proposal → execute identical proposal (same nonce) → assert revert `NonceAlreadyUsed` | contract |
| byos-contracts | Expired `validUntil` reverts `Trampoline.execute` | Build proposal with `validUntil = block.timestamp - 1` → `execute()` → assert revert | contract |
| byos-contracts | Tampered interactions array fails signature verification | Sign interactions → replace one interaction calldata → `execute()` → assert revert | contract |
| byos-contracts | `tx.origin` without `SUBMITTER_ROLE` reverts `execute` | Call `execute` with a non-submitter EOA as `tx.origin` → assert revert | contract |
| byos-contracts | `msg.sender != GPv2Settlement` reverts `execute` | Call `execute` directly (not through GPv2Settlement) → assert revert | contract |
| byos-contracts | `minBuyAmount` floor enforced: settlement reverts when `delta < minBuyAmount` | Build route that delivers `minBuyAmount - 1` → settlement → assert full revert, no trade occurs | contract |
| byos-contracts | Over-delivery surplus stays in settlement (not returned to sub-solver) | Build route delivering `quoteBuyAmount + surplus` → assert settlement's buy-token balance grows by full amount, instance ends at zero | contract |

---

## Trampoline Residue Claims

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-contracts | `claimToken` sends non-trade-token residue to sub-solver | Transfer random ERC20 to Trampoline instance → `claimToken(token, subSolver)` → assert sub-solver received full balance | contract |
| byos-contracts | `claimTokens` batch-claims multiple residue tokens | Send 3 ERC20s to instance → `claimTokens([t1,t2,t3], sub)` → assert all three balances transferred | contract |
| byos-contracts | `claimToken` is callable only by the owning sub-solver | Third party calls `claimToken` on another sub-solver's instance → assert revert | contract |

---

## Trampoline Lazy Deployment

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-contracts | First deposit for a new sub-solver deploys a Trampoline at the expected CREATE2 address | Fresh address → `deposit(subSolver)` → assert `factory.addressOf(subSolver)` has code | contract |
| byos-contracts | `ensureDeployed` is idempotent and returns the same address | Call `factory.ensureDeployed(sub)` twice → no revert; address unchanged | contract |

---

## Track B Penalties

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-service-ts | EBBO certificate receipt triggers immediate `freeze()` on affected sub-solver | Integration: service receives Track B notification → assert `escrow.freeze(subSolver)` called; proposal reads still return 404 for non-owner | integration |
| byos-service-ts | Upheld EBBO violation triggers debit and unfreeze | Integration: Track B resolution = upheld → assert `debit(subSolver, amount)` then `unfreeze(subSolver)` called in order | integration |
| byos-service-ts | Overturned EBBO violation triggers unfreeze only (no debit) | Integration: Track B resolution = overturned → assert only `unfreeze(subSolver)` called, no debit | integration |

---

## Reference Sub-Solver

| Repo | Feature | Test | Type |
|---|---|---|---|
| byos-service-ts | Sub-solver sets `minBuyAmount < quoteBuyAmount` to absorb front-running slippage | Unit (`subsolver/routing`): simulate shifted Uniswap reserves between quote and execution → verify proposal correctly uses quote reserves for `quoteBuyAmount` and on-chain floor for `minBuyAmount` | unit |

---

## Summary

| Category | Missing tests |
|---|---|
| Buffer / loose slippage | 7 |
| Order validation (amounts) | 5 |
| Validation lifecycle | 5 |
| Settlement outcomes | 3 |
| Solver engine / crafting | 5 |
| Security / access control | 3 |
| Escrow withdrawal cooldown | 5 |
| Escrow freeze & pause | 7 |
| Escrow invariant | 1 |
| On-chain Trampoline enforcement | 7 |
| Trampoline residue claims | 3 |
| Trampoline lazy deployment | 2 |
| Track B penalties | 3 |
| Reference sub-solver | 1 |
| **Total** | **57** |
