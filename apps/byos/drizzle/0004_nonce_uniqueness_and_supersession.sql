ALTER TABLE "proposals" ADD COLUMN "superseded_by_proposal_id" bigint;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_superseded_by_proposal_id_proposals_id_fk" FOREIGN KEY ("superseded_by_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_sub_solver_nonce_key" ON "proposals" USING btree ("sub_solver","nonce");
