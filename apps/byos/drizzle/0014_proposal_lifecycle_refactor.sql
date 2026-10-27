-- Add buy_token_ref_price to proposals
ALTER TABLE proposals ADD COLUMN buy_token_ref_price text;
--> statement-breakpoint

-- Add buy_token_ref_price to proposals_log
ALTER TABLE proposals_log ADD COLUMN buy_token_ref_price text;
--> statement-breakpoint

-- Remove pending_cancellation from proposals
ALTER TABLE proposals DROP COLUMN IF EXISTS pending_cancellation;
--> statement-breakpoint

-- Remove pending_cancellation from proposals_log
ALTER TABLE proposals_log DROP COLUMN IF EXISTS pending_cancellation;
--> statement-breakpoint

-- Remove nonce unique index (nonce uniqueness enforced on-chain by trampoline)
DROP INDEX IF EXISTS proposals_sub_solver_nonce_key;
--> statement-breakpoint

-- Remove solutions table
DROP TABLE IF EXISTS solutions;
--> statement-breakpoint

-- Remove cascade deletion from buffer_entries.proposal_id so buffer
-- ledger entries survive independent of the live proposal row.
ALTER TABLE buffer_entries DROP CONSTRAINT IF EXISTS buffer_entries_proposal_id_proposals_id_fk;
--> statement-breakpoint

-- Update the sync_proposal_to_log trigger to include buy_token_ref_price.
-- The trigger uses an explicit column list, so new columns must be added here.
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
			settlement_tx_hash, penalty_tx_hash,
			simulation_failure_params,
			sell_token_ref_price, validation_sell_token_ref_price,
			buy_token_ref_price,
			settlement_penalty_cap, surplus_token_ref_price,
			auction_gas_price, clearing_prices, simulation_buy_amount,
			auction_id, created_at, status_changed_at
		) VALUES (
			NEW.id, NEW.sub_solver, NEW.order_uid, NEW.order_uid_hash,
			NEW.sell_amount, NEW.min_buy_amount, NEW.quote_buy_amount,
			NEW.sell_token, NEW.buy_token, NEW.interactions, NEW.interactions_hash,
			NEW.valid_until, NEW.nonce, NEW.signature,
			NEW.status, NEW.rejection_reason, NEW.gas_used, NEW.trampoline,
			NEW.settlement_tx_hash, NEW.penalty_tx_hash,
			NEW.simulation_failure_params,
			NEW.sell_token_ref_price, NEW.validation_sell_token_ref_price,
			NEW.buy_token_ref_price,
			NEW.settlement_penalty_cap, NEW.surplus_token_ref_price,
			NEW.auction_gas_price, NEW.clearing_prices, NEW.simulation_buy_amount,
			NEW.auction_id, NEW.created_at, NEW.status_changed_at
		) ON CONFLICT (id) DO UPDATE SET
			status                       = EXCLUDED.status,
			rejection_reason             = EXCLUDED.rejection_reason,
			gas_used                     = EXCLUDED.gas_used,
			trampoline                   = EXCLUDED.trampoline,
			sell_token                   = EXCLUDED.sell_token,
			buy_token                    = EXCLUDED.buy_token,
			settlement_tx_hash           = EXCLUDED.settlement_tx_hash,
			penalty_tx_hash              = EXCLUDED.penalty_tx_hash,
			simulation_failure_params    = EXCLUDED.simulation_failure_params,
			sell_token_ref_price         = EXCLUDED.sell_token_ref_price,
			validation_sell_token_ref_price = EXCLUDED.validation_sell_token_ref_price,
			buy_token_ref_price          = EXCLUDED.buy_token_ref_price,
			settlement_penalty_cap       = EXCLUDED.settlement_penalty_cap,
			surplus_token_ref_price      = EXCLUDED.surplus_token_ref_price,
			auction_gas_price            = EXCLUDED.auction_gas_price,
			clearing_prices              = EXCLUDED.clearing_prices,
			simulation_buy_amount        = EXCLUDED.simulation_buy_amount,
			status_changed_at            = EXCLUDED.status_changed_at;

	ELSIF TG_OP = 'UPDATE' THEN
		UPDATE proposals_log SET
			status                       = NEW.status,
			rejection_reason             = NEW.rejection_reason,
			gas_used                     = NEW.gas_used,
			trampoline                   = NEW.trampoline,
			sell_token                   = NEW.sell_token,
			buy_token                    = NEW.buy_token,
			settlement_tx_hash           = NEW.settlement_tx_hash,
			penalty_tx_hash              = NEW.penalty_tx_hash,
			simulation_failure_params    = NEW.simulation_failure_params,
			sell_token_ref_price         = NEW.sell_token_ref_price,
			validation_sell_token_ref_price = NEW.validation_sell_token_ref_price,
			buy_token_ref_price          = NEW.buy_token_ref_price,
			settlement_penalty_cap       = NEW.settlement_penalty_cap,
			surplus_token_ref_price      = NEW.surplus_token_ref_price,
			auction_gas_price            = NEW.auction_gas_price,
			clearing_prices              = NEW.clearing_prices,
			simulation_buy_amount        = NEW.simulation_buy_amount,
			status_changed_at            = NEW.status_changed_at
		WHERE id = NEW.id;

	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
