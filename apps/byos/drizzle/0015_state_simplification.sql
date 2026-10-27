-- Migrate penalized rows in proposals_log to settleFailed with penalty_tx_hash set.
-- These rows already have penalty_tx_hash populated; keeping status = 'penalized'
-- would leave them invisible to the new penalty_tx_hash IS NULL filter.
UPDATE proposals_log
SET status = 'settleFailed'
WHERE status = 'penalized';
--> statement-breakpoint

-- Drop the penalties table. Non-settlement debits are now tracked via
-- proposals_log.penalty_tx_hash on lost rows, mirroring how revert debits
-- were already tracked via proposals_log.penalty_tx_hash on settleFailed rows.
DROP TABLE IF EXISTS penalties;
--> statement-breakpoint

-- Merge ready/retrying debit_operations statuses into a single pending state.
-- Both were treated identically by all queries; the distinction ("never tried"
-- vs "failed at least once") is now captured by attempt_count = 0.
UPDATE debit_operations
SET status = 'pending'
WHERE status IN ('ready', 'retrying');
--> statement-breakpoint

ALTER TABLE debit_operations
ALTER COLUMN status SET DEFAULT 'pending';
