CREATE TABLE IF NOT EXISTS "slippage_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sub_solver" text NOT NULL,
	"proposal_id" bigint NOT NULL REFERENCES "proposals"("id") ON DELETE CASCADE,
	"order_uid" text NOT NULL,
	"delta" text NOT NULL,
	"gap" text NOT NULL,
	"eth_amount" text NOT NULL,
	"cleared" boolean NOT NULL DEFAULT false,
	"clear_tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slippage_entries_sub_solver_cleared_idx" ON "slippage_entries" USING btree ("sub_solver","cleared");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slippage_entries_proposal_id_idx" ON "slippage_entries" USING btree ("proposal_id");
