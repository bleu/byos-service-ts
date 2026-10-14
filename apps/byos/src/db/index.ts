import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(url: string, maxConnections = 50) {
	const client = postgres(url, { max: maxConnections });
	const db = drizzle(client, { schema });
	return { db, client };
}

export type Db = ReturnType<typeof createDb>["db"];
