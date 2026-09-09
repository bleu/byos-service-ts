import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		passWithNoTests: true,
		projects: [
			{
				test: {
					name: "unit",
					include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
					exclude: ["**/*.db.test.ts", "**/*.redis.test.ts"],
					env: dotenvConfig({ path: resolve(".env") }).parsed ?? {},
				},
			},
			{
				test: {
					name: "db",
					include: ["apps/*/src/**/*.db.test.ts"],
				},
			},
			{
				test: {
					name: "redis",
					include: ["apps/*/src/**/*.redis.test.ts"],
				},
			},
			{
				test: {
					name: "integration",
					root: "tests/integration",
					include: ["**/*.test.ts"],
				},
			},
			{
				test: {
					name: "onchain",
					root: "tests/onchain",
					include: ["**/*.test.ts"],
					testTimeout: 60_000,
				},
			},
			{
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
