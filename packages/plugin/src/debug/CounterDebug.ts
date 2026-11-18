import { Notice } from "obsidian";
import type * as Y from "yjs";

const MAP_NAME = "debug";
const KEY = "counter";

/**
 * P0 end-to-end proof: two vaults share the workspace index doc, one runs "Debug counter +1",
 * the other sees a Notice. Rides the session's index doc: `ConnectionManager.openDoc` dedupes
 * by name, so a second Y.Doc for the same name would never sync.
 */
export class CounterDebug {
	private readonly map: Y.Map<number>;
	private readonly observer = (_event: Y.YMapEvent<number>, transaction: Y.Transaction) => {
		if (transaction.local) return;
		new Notice(`TeamSync counter: ${this.map.get(KEY) ?? 0}`);
	};

	constructor(indexDoc: Y.Doc) {
		this.map = indexDoc.getMap<number>(MAP_NAME);
		this.map.observe(this.observer);
	}

	/** Returns the new value. */
	increment(): number {
		const next = (this.map.get(KEY) ?? 0) + 1;
		this.map.set(KEY, next);
		return next;
	}

	close(): void {
		this.map.unobserve(this.observer);
	}
}
