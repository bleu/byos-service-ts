CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"proposal_id" bigint NOT NULL,
	"event_type" text NOT NULL,
	"sub_solver" text NOT NULL,
	"order_uid" text NOT NULL,
	"settlement_tx_hash" text,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "penalties" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"proposal_id" bigint NOT NULL,
	"sub_solver" text NOT NULL,
	"order_uid" text NOT NULL,
	"penalty_tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sub_solver" text NOT NULL,
	"order_uid" text NOT NULL,
	"order_uid_hash" text NOT NULL,
	"sell_amount" text NOT NULL,
	"buy_amount" text NOT NULL,
	"sell_token" text NOT NULL,
	"buy_token" text NOT NULL,
	"interactions" jsonb NOT NULL,
	"interactions_hash" text NOT NULL,
	"valid_until" text NOT NULL,
	"nonce" text NOT NULL,
	"signature" text NOT NULL,
	"status" text NOT NULL,
	"rejection_reason" text,
	"gas_used" bigint,
	"trampoline" text,
	"settlement_tx_hash" text,
	"penalty_tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "solutions" (
	"auction_id" bigint NOT NULL,
	"solution_id" bigint NOT NULL,
	"proposal_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "solutions_auction_id_solution_id_pk" PRIMARY KEY("auction_id","solution_id")
);
--> statement-breakpoint
ALTER TABLE "solutions" ADD CONSTRAINT "solutions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_proposal_id_idx" ON "audit_events" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "audit_events_order_uid_idx" ON "audit_events" USING btree ("order_uid");--> statement-breakpoint
CREATE INDEX "audit_events_sub_solver_idx" ON "audit_events" USING btree ("sub_solver");--> statement-breakpoint
CREATE INDEX "audit_events_settlement_tx_hash_idx" ON "audit_events" USING btree ("settlement_tx_hash") WHERE settlement_tx_hash IS NOT NULL;--> statement-breakpoint
CREATE INDEX "penalties_pending_idx" ON "penalties" USING btree ("id") WHERE penalty_tx_hash IS NULL;--> statement-breakpoint
CREATE INDEX "proposals_order_uid_status_idx" ON "proposals" USING btree ("order_uid","status");--> statement-breakpoint
CREATE INDEX "proposals_sub_solver_status_idx" ON "proposals" USING btree ("sub_solver","status");--> statement-breakpoint
CREATE INDEX "proposals_status_status_changed_at_idx" ON "proposals" USING btree ("status","status_changed_at");--> statement-breakpoint
CREATE INDEX "solutions_proposal_id_idx" ON "solutions" USING btree ("proposal_id");