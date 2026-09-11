import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// Obsidian's runtime module does not exist outside the app.
			obsidian: fileURLToPath(new URL("./src/__mocks__/obsidian.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
