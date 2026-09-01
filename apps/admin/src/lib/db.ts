import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

function getDatabaseUrl(): string {
	const url = process.env.DATABASE_URL;
	if (!url) {
		if (process.env.NODE_ENV === "production") {
			throw new Error("DATABASE_URL env var is required in production");
		}
		return "postgres://postgres:postgres@localhost:5432/byos";
	}
	return url;
}

// Single connection pool — created once at module scope and reused across
// all server-component renders. Max 5 connections is plenty for an admin tool.
const client = postgres(getDatabaseUrl(), { max: 5 });

export const db = drizzle(client, { schema });
export type Db = typeof db;
