declare module "*.svelte" {
	import type { Component } from "svelte";

	const component: Component<Record<string, unknown>>;
	export default component;
}

/** Injected by esbuild `define`. */
declare const BUILD_TYPE: "debug" | "prod";
declare const GIT_TAG: string;
