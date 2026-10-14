import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/resume-debit.ts", "src/redis-history.ts"],
	format: ["esm"],
	target: "node22",
	outDir: "dist",
	clean: true,
	sourcemap: true,
	splitting: false,
	loader: { ".yml": "text" },
});
