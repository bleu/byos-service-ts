import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { defineConfig } from "vitest/config";

/**
 * Parse a .env file and return its values without mutating process.env.
 * dotenv's config() mutates process.env by default, which causes env vars
 * from one project (e.g. CHAIN_ID=56 from .env.byos) to bleed into workers
 * spawned for other projects (e.g. e2e) before vitest applies project-level
 * env overrides.
 */
function parseEnv(path: string): Record<string, string> {
	return dotenvConfig({ path, processEnv: {} }).parsed ?? {};
}

// Mirrors tsup's loader: { '.yml': 'text' } so tests can import .yml files.
// resolveId claims ownership of .yml files so Vite skips its built-in file
// serving (which would pass raw YAML to vite:import-analysis and fail).
const yamlTextPlugin = {
	name: "yaml-text",
	enforce: "pre" as const,
	resolveId(id: string, importer: string | undefined) {
		if ((id.endsWith(".yml") || id.endsWith(".yaml")) && !isAbsolute(id) && importer) {
			return resolve(dirname(importer), id);
		}
	},
	load(id: string) {
		if (id.endsWith(".yml") || id.endsWith(".yaml")) {
			return `export default ${JSON.stringify(readFileSync(id, "utf8"))}`;
		}
	},
};

export default defineConfig({
	test: {
		passWithNoTests: true,
		projects: [
			{
				plugins: [yamlTextPlugin],
				// Exercise current workspace source rather than a potentially stale dist build.
				resolve: {
					alias: { "@byos/subsolver-core": resolve("packages/subsolver-core/src/index.ts") },
				},
				test: {
					name: "unit",
					include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
					exclude: ["**/*.db.test.ts", "**/*.redis.test.ts"],
					env: parseEnv(resolve(".env")),
				},
			},
			{
				plugins: [yamlTextPlugin],
				test: {
					name: "db",
					include: ["apps/*/src/**/*.db.test.ts"],
				},
			},
			{
				plugins: [yamlTextPlugin],
				test: {
					name: "redis",
					include: ["apps/*/src/**/*.redis.test.ts"],
				},
			},
			{
				plugins: [yamlTextPlugin],
				test: {
					name: "integration",
					root: "tests/integration",
					include: ["**/*.test.ts"],
				},
			},
			{
				plugins: [yamlTextPlugin],
				test: {
					name: "onchain",
					root: "tests/onchain",
					include: ["**/*.test.ts"],
					testTimeout: 60_000,
				},
			},
			{
				plugins: [yamlTextPlugin],
				test: {
					name: "e2e",
					root: "tests/e2e",
					include: ["**/*.test.ts"],
					testTimeout: 120_000,
					hookTimeout: 60_000,
					env: parseEnv(resolve(".env.e2e")),
				},
			},
		],
	},
});
