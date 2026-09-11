import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// PGlite must never initialise concurrently in one process (nodejs/node#64500),
		// so test files run one at a time and each creates a single instance.
		pool: "forks",
		fileParallelism: false,
		testTimeout: 30_000,
		hookTimeout: 60_000,
	},
});
