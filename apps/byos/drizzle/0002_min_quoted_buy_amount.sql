ALTER TABLE "proposals" ADD COLUMN "min_buy_amount" text NOT NULL DEFAULT '0';--> statement-breakpoint
UPDATE "proposals" SET "min_buy_amount" = "buy_amount";--> statement-breakpoint
ALTER TABLE "proposals" RENAME COLUMN "buy_amount" TO "quoted_buy_amount";--> statement-breakpoint
ALTER TABLE "solutions" ADD COLUMN "buy_token_ref_price" text NOT NULL DEFAULT '0';
