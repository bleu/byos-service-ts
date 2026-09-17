-- Add simulation_failure_params to proposals (nullable; swept with the row after
-- DROPPED_RETENTION_SECS, but mirrored permanently into proposals_log via trigger).
ALTER TABLE "proposals" ADD COLUMN "simulation_failure_params" jsonb;
--> statement-breakpoint

-- Permanent history table: same shape as proposals plus simulation_failure_params.
-- Rows are inserted/updated by the trigger below and are NEVER deleted.
-- The primary key reuses the proposals.id — one log row per proposal, no new serial.
CREATE TABLE "proposals_log" (
	"id"                        bigint PRIMARY KEY NOT NULL,
	"sub_solver"                text NOT NULL,
	"order_uid"                 text NOT NULL,
	"order_uid_hash"            text NOT NULL,
	"sell_amount"               text NOT NULL,
	"min_buy_amount"            text NOT NULL,
	"quote_buy_amount"          text NOT NULL,
	"sell_token"                text NOT NULL,
	"buy_token"                 text NOT NULL,
	"interactions"              jsonb NOT NULL,
	"interactions_hash"         text NOT NULL,
	"valid_until"               text NOT NULL,
	"nonce"                     text NOT NULL,
	"signature"                 text NOT NULL,
	"status"                    text NOT NULL,
	"rejection_reason"          text,
	"gas_used"                  bigint,
	"trampoline"                text,
	"settlement_tx_hash"        text,
	"penalty_tx_hash"           text,
	"pending_cancellation"      boolean NOT NULL DEFAULT false,
	"simulation_failure_params" jsonb,
	"created_at"                timestamp with time zone NOT NULL DEFAULT now(),
	"status_changed_at"         timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX "proposals_log_created_at_idx"  ON "proposals_log" ("created_at");
CREATE INDEX "proposals_log_sub_solver_idx"  ON "proposals_log" ("sub_solver");
CREATE INDEX "proposals_log_status_idx"      ON "proposals_log" ("status");
--> statement-breakpoint

-- Trigger function: mirrors every INSERT and UPDATE on proposals into proposals_log.
-- DELETE is intentionally not handled — proposals_log rows are never pruned.
CREATE OR REPLACE FUNCTION sync_proposal_to_log()
RETURNS TRIGGER AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO proposals_log (
			id, sub_solver, order_uid, order_uid_hash,
			sell_amount, min_buy_amount, quote_buy_amount,
			sell_token, buy_token, interactions, interactions_hash,
			valid_until, nonce, signature,
			status, rejection_reason, gas_used, trampoline,
			settlement_tx_hash, penalty_tx_hash, pending_cancellation,
			simulation_failure_params, created_at, status_changed_at
		) VALUES (
			NEW.id, NEW.sub_solver, NEW.order_uid, NEW.order_uid_hash,
			NEW.sell_amount, NEW.min_buy_amount, NEW.quote_buy_amount,
			NEW.sell_token, NEW.buy_token, NEW.interactions, NEW.interactions_hash,
			NEW.valid_until, NEW.nonce, NEW.signature,
			NEW.status, NEW.rejection_reason, NEW.gas_used, NEW.trampoline,
			NEW.settlement_tx_hash, NEW.penalty_tx_hash, NEW.pending_cancellation,
			NEW.simulation_failure_params, NEW.created_at, NEW.status_changed_at
		);

	ELSIF TG_OP = 'UPDATE' THEN
		UPDATE proposals_log SET
			status                    = NEW.status,
			rejection_reason          = NEW.rejection_reason,
			gas_used                  = NEW.gas_used,
			trampoline                = NEW.trampoline,
			sell_token                = NEW.sell_token,
			buy_token                 = NEW.buy_token,
			settlement_tx_hash        = NEW.settlement_tx_hash,
			penalty_tx_hash           = NEW.penalty_tx_hash,
			pending_cancellation      = NEW.pending_cancellation,
			simulation_failure_params = NEW.simulation_failure_params,
			status_changed_at         = NEW.status_changed_at
		WHERE id = NEW.id;

	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER proposals_log_sync
AFTER INSERT OR UPDATE ON proposals
FOR EACH ROW
EXECUTE FUNCTION sync_proposal_to_log();
--> statement-breakpoint

-- Backfill existing proposals that are already in the operational table.
INSERT INTO proposals_log (
	id, sub_solver, order_uid, order_uid_hash,
	sell_amount, min_buy_amount, quote_buy_amount,
	sell_token, buy_token, interactions, interactions_hash,
	valid_until, nonce, signature,
	status, rejection_reason, gas_used, trampoline,
	settlement_tx_hash, penalty_tx_hash, pending_cancellation,
	simulation_failure_params, created_at, status_changed_at
)
SELECT
	id, sub_solver, order_uid, order_uid_hash,
	sell_amount, min_buy_amount, quote_buy_amount,
	sell_token, buy_token, interactions, interactions_hash,
	valid_until, nonce, signature,
	status, rejection_reason, gas_used, trampoline,
	settlement_tx_hash, penalty_tx_hash, pending_cancellation,
	NULL, created_at, status_changed_at
FROM proposals
ON CONFLICT (id) DO NOTHING;
