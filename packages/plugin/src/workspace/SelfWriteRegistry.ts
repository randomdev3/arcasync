export type SelfWriteKind = "modify" | "create" | "rename" | "delete";

export interface SelfWriteExpectation {
	kind: SelfWriteKind;
	/** Content hash of the write; when both sides give one, they must match. */
	hash?: string;
	/** How long the expectation stays consumable. Default 60 s. */
	ttlMs?: number;
}

interface Entry {
	kind: SelfWriteKind;
	hash: string | undefined;
	expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;

/**
 * Remembers the vault writes TeamSync makes itself, so the vault event they trigger is not
 * mistaken for a user edit and echoed back. Register right before writing; the watcher calls
 * `consume` for each event. Keys are vault paths; for a rename, the new path.
 */
export class SelfWriteRegistry {
	private readonly entries = new Map<string, Entry[]>();

	constructor(private readonly now: () => number = Date.now) {}

	expect(path: string, { kind, hash, ttlMs = DEFAULT_TTL_MS }: SelfWriteExpectation): void {
		const list = this.live(path);
		list.push({ kind, hash, expiresAt: this.now() + ttlMs });
		this.entries.set(path, list);
	}

	/**
	 * True when the event matches an unexpired expectation, which is then used up. An
	 * expectation matches one event only; a hash mismatch means someone else wrote the file.
	 */
	consume(path: string, kind: SelfWriteKind, hash?: string): boolean {
		const list = this.live(path);
		const index = list.findIndex(
			(e) => e.kind === kind && (e.hash === undefined || hash === undefined || e.hash === hash),
		);
		if (index >= 0) list.splice(index, 1);
		if (list.length > 0) this.entries.set(path, list);
		else this.entries.delete(path);
		return index >= 0;
	}

	/** Paths with at least one unexpired expectation. */
	get size(): number {
		let n = 0;
		for (const path of this.entries.keys()) if (this.live(path).length > 0) n++;
		return n;
	}

	clear(): void {
		this.entries.clear();
	}

	private live(path: string): Entry[] {
		const now = this.now();
		return (this.entries.get(path) ?? []).filter((e) => e.expiresAt > now);
	}
}
