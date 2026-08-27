WITH newest_active AS (
  SELECT DISTINCT ON (sub_solver, order_uid) id, sub_solver, order_uid
  FROM "proposals"
  WHERE status = 'active'
  ORDER BY sub_solver, order_uid, id DESC
)
UPDATE "proposals" AS old
SET status = 'cancelled', status_changed_at = now()
FROM newest_active
WHERE old.sub_solver = newest_active.sub_solver
  AND old.order_uid = newest_active.order_uid
  AND old.id < newest_active.id
  AND old.status IN ('submitted', 'active');--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_sub_solver_nonce_key" ON "proposals" USING btree ("sub_solver","nonce");
