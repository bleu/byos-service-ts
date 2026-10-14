ALTER TABLE "solutions" DROP CONSTRAINT "solutions_auction_id_solution_id_proposal_id_pk";
--> statement-breakpoint
DELETE FROM "solutions" s1
USING "solutions" s2
WHERE s1.auction_id = s2.auction_id
  AND s1.solution_id = s2.solution_id
  AND s1.proposal_id > s2.proposal_id;
--> statement-breakpoint
ALTER TABLE "solutions" ADD CONSTRAINT "solutions_auction_id_solution_id_pk" PRIMARY KEY ("auction_id", "solution_id");
--> statement-breakpoint
ALTER TABLE "penalties" DROP CONSTRAINT IF EXISTS "penalties_source_id_unique";
--> statement-breakpoint
ALTER TABLE "penalties" DROP COLUMN IF EXISTS "source_id";
