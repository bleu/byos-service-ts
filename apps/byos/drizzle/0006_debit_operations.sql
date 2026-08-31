CREATE TABLE IF NOT EXISTS "debit_operations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"sub_solver" text NOT NULL,
	"amount" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL DEFAULT 'ready',
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" bigint NOT NULL DEFAULT 0,
	"last_error" text,
	"next_retry_at" timestamp with time zone,
	"raw_transaction" text,
	"transaction_hash" text,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "debit_operations_source_idx" ON "debit_operations" USING btree ("source_kind", "source_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "debit_operations_source_kind_status_idx" ON "debit_operations" USING btree ("source_kind", "status");
