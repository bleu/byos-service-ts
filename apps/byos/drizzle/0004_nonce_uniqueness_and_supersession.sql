ALTER TABLE "proposals" ADD COLUMN "superseded_by_proposal_id" bigint;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_superseded_by_proposal_id_proposals_id_fk" FOREIGN KEY ("superseded_by_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
WITH newest_active AS (
  SELECT DISTINCT ON (sub_solver, order_uid) id, sub_solver, order_uid
  FROM "proposals"
  WHERE status = 'active'
  ORDER BY sub_solver, order_uid, id DESC
)
UPDATE "proposals" AS old
SET status = 'superseded', superseded_by_proposal_id = newest_active.id
FROM newest_active
WHERE old.sub_solver = newest_active.sub_solver
  AND old.order_uid = newest_active.order_uid
  AND old.id < newest_active.id
  AND old.status IN ('submitted', 'active');--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_sub_solver_nonce_key" ON "proposals" USING btree ("sub_solver","nonce");
