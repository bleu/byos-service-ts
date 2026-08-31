CREATE TABLE IF NOT EXISTS "service_state" (
	"id" integer PRIMARY KEY NOT NULL DEFAULT 1 CONSTRAINT "service_state_singleton" CHECK ("id" = 1),
	"latest_auction_gas_price" text,
	"latest_auction_gas_price_at" timestamp with time zone
);
