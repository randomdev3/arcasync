import { docName } from "@teamsync/shared";
import { Notice } from "obsidian";
import * as Y from "yjs";
import type { ConnectionManager, OpenDocHandle } from "../net/ConnectionManager";

const MAP_NAME = "debug";
const KEY = "counter";

/**
 * P0 end-to-end proof: two vaults open the same workspace index doc, one runs
 * "Debug counter +1", the other sees a Notice. Nothing else in the plugin
 * depends on this.
 */
export class CounterDebug {
	private ydoc: Y.Doc | null = null;
	private handle: OpenDocHandle | null = null;
	private unobserve: (() => void) | null = null;

	constructor(private readonly connections: ConnectionManager) {}

	get isOpen(): boolean {
		return this.ydoc !== null;
	}

	open(workspaceId: string): void {
		if (this.ydoc) this.close();
		const name = docName({ workspaceId, kind: "index" });
		const ydoc = new Y.Doc();
		const map = ydoc.getMap<number>(MAP_NAME);
		const observer = (_event: Y.YMapEvent<number>, transaction: Y.Transaction) => {
			if (transaction.local) return;
			new Notice(`TeamSync counter: ${map.get(KEY) ?? 0}`);
		};
		map.observe(observer);

		this.ydoc = ydoc;
		this.unobserve = () => map.unobserve(observer);
		this.handle = this.connections.openDoc(name, ydoc);
	}

	/** Returns the new value, or null when the doc is not open. */
	increment(): number | null {
		if (!this.ydoc) return null;
		const map = this.ydoc.getMap<number>(MAP_NAME);
		const next = (map.get(KEY) ?? 0) + 1;
		map.set(KEY, next);
		return next;
	}

	close(): void {
		this.unobserve?.();
		this.unobserve = null;
		this.handle?.close();
		this.handle = null;
		this.ydoc?.destroy();
		this.ydoc = null;
	}
}
