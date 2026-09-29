import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { defineConfig } from "vitest/config";

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
				test: {
					name: "unit",
					include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
					exclude: ["**/*.db.test.ts", "**/*.redis.test.ts"],
					env: dotenvConfig({ path: resolve(".env") }).parsed ?? {},
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
					env: dotenvConfig({ path: resolve(".env.e2e") }).parsed ?? {},
				},
			},
		],
	},
});
