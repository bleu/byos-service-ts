import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { seedDashboardFixture } from "../src/lib/dashboard-fixture.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const sql = postgres(databaseUrl);
try {
	await migrate(drizzle(sql), {
		migrationsFolder: resolve(import.meta.dirname, "../../byos/drizzle"),
	});
	await seedDashboardFixture(sql);
} finally {
	await sql.end();
}
