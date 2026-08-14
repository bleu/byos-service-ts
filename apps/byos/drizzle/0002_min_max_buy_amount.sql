ALTER TABLE "proposals" RENAME COLUMN "buy_amount" TO "max_buy_amount";--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "min_buy_amount" text NOT NULL DEFAULT '0';--> statement-breakpoint
ALTER TABLE "solutions" ADD COLUMN "buy_token_ref_price" text NOT NULL DEFAULT '0';
