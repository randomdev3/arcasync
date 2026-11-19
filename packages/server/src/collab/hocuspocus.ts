import { Hocuspocus } from "@hocuspocus/server";
import type { Deps } from "../types.js";
import { createOnAuthenticate, createOnTokenSync } from "./auth.js";
import { createPersistence } from "./persistence.js";

export function createHocuspocus(deps: Deps): Hocuspocus {
	return new Hocuspocus({
		name: "arcasync",
		quiet: true,
		debounce: 2000,
		maxDebounce: 10000,
		extensions: [createPersistence(deps)],
		onAuthenticate: createOnAuthenticate(deps),
		onTokenSync: createOnTokenSync(deps),
	});
}

/**
 * Flushes pending `onStoreDocument` debounces, closes all connections and runs
 * `onDestroy`. Mirrors what the batteries-included `Server` class does on shutdown,
 * which is unavailable when driving the lower-level `Hocuspocus` class directly.
 */
export async function destroyHocuspocus(hocuspocus: Hocuspocus, timeoutMs = 10_000): Promise<void> {
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		timer.unref();
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		try {
			hocuspocus.configuration.extensions.push({
				async afterUnloadDocument({ instance }) {
					if (instance.getDocumentsCount() === 0) done();
				},
			});
			if (hocuspocus.getDocumentsCount() === 0) {
				done();
				return;
			}
			hocuspocus.closeConnections();
			hocuspocus.flushPendingStores();
		} catch {
			done();
		}
	});
	await hocuspocus.hooks("onDestroy", { instance: hocuspocus });
}
