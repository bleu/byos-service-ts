CREATE TABLE IF NOT EXISTS "service_state" (
	"id" boolean PRIMARY KEY NOT NULL DEFAULT true,
	"latest_auction_gas_price" text,
	"latest_auction_gas_price_at" timestamp with time zone
);
