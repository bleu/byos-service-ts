ALTER TABLE "proposals" DROP CONSTRAINT "proposals_superseded_by_proposal_id_proposals_id_fk";--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_superseded_by_proposal_id_proposals_id_fk" FOREIGN KEY ("superseded_by_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;
