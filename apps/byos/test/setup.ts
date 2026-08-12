import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb, type Db } from "../src/db/index.js";

const ADMIN_URL = process.env.BYOS_TEST_DB_URL ?? "postgres://postgres:postgres@localhost:5432";
const STALE_HOURS = 3;

let counter = 0;
let swept = false;

/** Sweep test databases older than 3 hours (once per process). */
async function sweepStaleTestDbs(): Promise<void> {
	if (swept) return;
	swept = true;

	const client = postgres(ADMIN_URL);
	try {
		const rows = await client`
			SELECT datname FROM pg_database WHERE datname LIKE 'byos_test_%'
		`;

		const now = Date.now();
		const staleMs = STALE_HOURS * 60 * 60 * 1000;

		for (const row of rows) {
			const name = row.datname as string;
			// Parse timestamp from name: byos_test_{pid}_{timestamp}_{counter}
			const parts = name.split("_");
			const ts = Number(parts[3]);
			if (!Number.isNaN(ts) && now - ts > staleMs) {
				try {
					await client.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
				} catch {
					// Ignore errors from concurrent drops
				}
			}
		}
	} finally {
		await client.end();
	}
}

export interface TestContext {
	db: Db;
	url: string;
	cleanup: () => Promise<void>;
}

/** Creates a unique test database, runs migrations, and returns a Drizzle instance. */
export async function createTestDb(): Promise<TestContext> {
	await sweepStaleTestDbs();

	const pid = process.pid;
	const ts = Date.now();
	const idx = counter++;
	const dbName = `byos_test_${pid}_${ts}_${idx}`;

	// Create the database
	const adminClient = postgres(ADMIN_URL);
	try {
		await adminClient.unsafe(`CREATE DATABASE "${dbName}"`);
	} finally {
		await adminClient.end();
	}

	const url = `${ADMIN_URL}/${dbName}`;
	const { db, client } = createDb(url);

	// Run migrations
	const migrationsFolder = resolve(import.meta.dirname, "../drizzle");
	await migrate(db, { migrationsFolder });

	const cleanup = async () => {
		await client.end();
		const admin = postgres(ADMIN_URL);
		try {
			await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
		} finally {
			await admin.end();
		}
	};

	return { db, url, cleanup };
}
