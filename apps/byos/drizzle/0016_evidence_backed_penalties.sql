CREATE TABLE settlement_attempts (
 id BIGSERIAL PRIMARY KEY,
 attempt_key TEXT NOT NULL UNIQUE,
 auction_id BIGINT NOT NULL,
 sub_solver TEXT NOT NULL,
 proposal_id BIGINT NOT NULL,
 order_uid TEXT NOT NULL,
 penalty_cap TEXT,
 amount TEXT,
 policy_version TEXT NOT NULL,
 started_at TIMESTAMPTZ,
 abandoned_at TIMESTAMPTZ,
 abandonment_kind TEXT,
 outcome TEXT,
 status TEXT NOT NULL DEFAULT 'awaiting_evidence',
 reconciliation_reason TEXT,
 penalty_tx_hash TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CONSTRAINT settlement_attempt_eligibility CHECK (
  status <> 'eligible' OR (started_at IS NOT NULL AND abandoned_at IS NOT NULL
   AND abandonment_kind IS NOT NULL AND abandonment_kind IN ('cancelled', 'expired', 'fail')
   AND amount IS NOT NULL AND penalty_cap IS NOT NULL AND outcome IS NULL
   AND amount::numeric > 0 AND amount::numeric = trunc(penalty_cap::numeric / 10))
 )
);
CREATE INDEX settlement_attempts_status_idx ON settlement_attempts(status);
--> statement-breakpoint
CREATE TABLE settlement_attempt_members (
 attempt_id BIGINT NOT NULL REFERENCES settlement_attempts(id),
 proposal_id BIGINT PRIMARY KEY
);
CREATE TABLE settlement_notifications (
 id BIGSERIAL PRIMARY KEY,
 attempt_id BIGINT NOT NULL REFERENCES settlement_attempts(id),
 kind TEXT NOT NULL,
 transaction_hash TEXT NOT NULL DEFAULT '',
 payload JSONB NOT NULL,
 solution_key TEXT NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX settlement_notifications_evidence_idx
 ON settlement_notifications(attempt_id, kind, transaction_hash, solution_key);
--> statement-breakpoint
-- Historical losses do not establish liability. Preserve signed transactions for
-- manual reconciliation; stop unsigned legacy operations from being broadcast.
UPDATE debit_operations SET status = 'needs_reconciliation',
 last_error = 'Legacy non-settlement charge requires driver evidence review',
 lease_owner = NULL, lease_expires_at = NULL, next_retry_at = NULL
WHERE source_kind = 'non-settlement' AND status <> 'completed';
