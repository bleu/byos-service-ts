# Non-settlement penalties: rollout and reconciliation

Deploy this correction with all old BYOS replicas stopped. Mixed old/new penalty
workers are unsafe because the old binary charges from proposal loss alone.

1. Stop the old BYOS HTTP processes and workers, allowing in-flight jobs to finish.
2. Back up the database and record the deployed image/commit.
3. Run the usual migration/startup with the new image. Migration 0016 creates the
   evidence tables and parks unfinished legacy non-settlement debit operations.
4. Verify timeout and `SolverOutbid` losses do not produce debit operations. A
   driver must provide matching auction/solution start and abandonment evidence
   before any new non-settlement debit is eligible. Drivers that do not emit
   `settlementStarted` produce no automated non-settlement charges.
5. Review historical charges and parked operations before taking any financial
   recovery action. This change neither refunds collateral nor broadcasts old
   transactions automatically.

Review new cases (missing cap, unexpected merging, or contradictory outcomes):

```sql
SELECT id, attempt_key, proposal_id, sub_solver, status, reconciliation_reason,
       started_at, abandoned_at, outcome, penalty_cap, amount, penalty_tx_hash
FROM settlement_attempts
WHERE status = 'needs_reconciliation'
ORDER BY id;

SELECT * FROM settlement_notifications WHERE attempt_id = :attempt_id ORDER BY id;
```

Review legacy operations:

```sql
SELECT id, source_id, sub_solver, amount, reason, status, transaction_hash,
       raw_transaction IS NOT NULL AS signed, last_error
FROM debit_operations
WHERE source_kind = 'non-settlement'
ORDER BY id;
```

A signed transaction can already be in a node's mempool even if its receipt is
missing. Check its on-chain outcome before compensating or authorizing any further
action. Do not blindly resume legacy operations: resuming the debit operation alone
does not establish liability or connect it to a new evidence-backed attempt.

For already debited proposals, correlate `proposals_log.penalty_tx_hash` with audit
and driver evidence. `SolverOutbid`, timeout, and `UnknownOutput` alone are not
sufficient evidence. Record any compensation decision and transaction separately;
keep the original charge and evidence intact.

For a new evidence-backed attempt paused solely because its retry budget was
exhausted, the existing `resume-debit` command rechecks the stored start and
abandonment evidence and atomically resumes both attempt and operation. It refuses
legacy operations and attempts with a conflicting outcome or other reconciliation
reason. It always preserves previously signed transaction bytes.
