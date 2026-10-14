ALTER TABLE "solutions" DROP CONSTRAINT "solutions_auction_id_solution_id_pk";
--> statement-breakpoint
ALTER TABLE "solutions" ADD CONSTRAINT "solutions_auction_id_solution_id_proposal_id_pk" PRIMARY KEY ("auction_id", "solution_id", "proposal_id");
--> statement-breakpoint
ALTER TABLE "penalties" ADD COLUMN "source_id" text;
--> statement-breakpoint
ALTER TABLE "penalties" ADD CONSTRAINT "penalties_source_id_unique" UNIQUE ("source_id");
