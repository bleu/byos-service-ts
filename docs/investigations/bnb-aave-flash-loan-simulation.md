# BNB Aave collateral swap simulated without borrowing

Investigated 2026-11-13. No production settings changed and no transactions submitted.

## Evidence

Order: `0xd584c00c2e60ac2d1fd7b31df0162ab52d38a22f3b332ba2295fef92597e77382394b5662a25b2e83ff39f8e10f9afca000776516af709c0`.

Production container `byos-bnb-prod-byos-1`, submitter
`0x0543F6f2eb3C94c11E946EbF9d73AA2394751e72`, has no
`FLASH_LOAN_ROUTER` environment value. Its bundled code contains the optional
`record.flashloanHint && this.flashLoanRouterAddress` gate and no deployment
registry resolver. The running image is
`sha256:44cc03e82ac5646337bd7d271ea64026563685caccf3f1a56d9c187340d9b207`.

The production log for proposal 89392 records simulation at block 133354905,
with settlement `0x9008d19f58aabd9ed0d60971565aa8510560ab41` as target.
GitHub main after merging PR #156 still contains that optional-router behavior;
the automatic-resolution changes in this workspace were not part of the merge.

## Differential historical replay

The original calldata was read from the production log's Tenderly URL. Both
calls used the production RPC's `eth_simulateV1`, original sender, and the same
historical base block, without state overrides.

| Call | Status | Gas used |
| --- | --- | --- |
| Original direct settlement | `0x0` (execution reverted) | 201753 |
| Same settlement inside `flashLoanAndSettle` | `0x1` | 1066943 |

The wrapper used the loan hint from the public order's signed appData:

- Router: `0x9da8b48441583a2b93e2ef8213aad0ec0b392c69`
- Borrower adapter: `0xdeCC46a4b09162F5369c5C80383AAa9159bCf192`
- Lender: `0x6807dc923806fE8Fd134338EABCA509979a7e0cB`
- Token: `0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c`
- Amount: `1554322994666691`

Without borrowing, the Aave pre-hook cannot transfer WBNB from the factory.
Its revert rolls back adapter creation; the hooks trampoline tolerates the
failed hook. Signature verification then calls the absent adapter and reverts.
The EIP-1271 error is a downstream symptom of missing flash loan funds.

## Resolution and regression coverage

The existing deployed implementation works when `FLASH_LOAN_ROUTER` is set to
the canonical address and the service container is recreated. The workspace's
automatic resolver removes this configuration dependency and always wraps
hinted orders. It must be included in a release to change deployed behavior.

A test of the merged implementation with a valid hint reproduced the wrong
target when router configuration was absent; supplying only the router address
made that test pass. The permanent regression fixture reconstructs the driver's
wire shape from this real public order and asserts canonical target selection,
loan encoding, EIP-1271 signature prefixing, and preservation of pre/post hooks.
The unit test mocks RPC results; the differential replay above independently
verified the actual settlement and repayment on historical chain state.

The public order was subsequently fulfilled; retrying it at latest state would
exercise an already-filled order rather than this original failure.
