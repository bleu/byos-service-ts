-- Add simulation_buy_amount column to proposals and proposals_log.
-- Stores Executed._delta from eth_simulateV1 — the actual buy-token amount
-- the route delivered during simulation. Nullable so existing rows are unaffected.
ALTER TABLE "proposals"
  ADD COLUMN IF NOT EXISTS "simulation_buy_amount" text;
--> statement-breakpoint

ALTER TABLE "proposals_log"
  ADD COLUMN IF NOT EXISTS "simulation_buy_amount" text;
--> statement-breakpoint

-- Update the sync trigger to mirror the new column.
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
			simulation_failure_params,
			sell_token_ref_price, surplus_token_ref_price, auction_gas_price, clearing_prices,
			simulation_buy_amount,
			created_at, status_changed_at
		) VALUES (
			NEW.id, NEW.sub_solver, NEW.order_uid, NEW.order_uid_hash,
			NEW.sell_amount, NEW.min_buy_amount, NEW.quote_buy_amount,
			NEW.sell_token, NEW.buy_token, NEW.interactions, NEW.interactions_hash,
			NEW.valid_until, NEW.nonce, NEW.signature,
			NEW.status, NEW.rejection_reason, NEW.gas_used, NEW.trampoline,
			NEW.settlement_tx_hash, NEW.penalty_tx_hash, NEW.pending_cancellation,
			NEW.simulation_failure_params,
			NEW.sell_token_ref_price, NEW.surplus_token_ref_price, NEW.auction_gas_price, NEW.clearing_prices,
			NEW.simulation_buy_amount,
			NEW.created_at, NEW.status_changed_at
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
			sell_token_ref_price      = NEW.sell_token_ref_price,
			surplus_token_ref_price   = NEW.surplus_token_ref_price,
			auction_gas_price         = NEW.auction_gas_price,
			clearing_prices           = NEW.clearing_prices,
			simulation_buy_amount     = NEW.simulation_buy_amount,
			status_changed_at         = NEW.status_changed_at
		WHERE id = NEW.id;

	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
