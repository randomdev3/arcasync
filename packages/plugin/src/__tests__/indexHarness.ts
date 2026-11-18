import * as Y from "yjs";
import { IndexStore } from "../workspace/IndexStore";
import type { KnownStore, LocalFiles } from "../workspace/LocalFiles";
import { Reconciler } from "../workspace/Reconciler";

export const REMOTE = "remote";

/** In-memory `LocalFiles`; `ops` logs every write the reconciler makes. */
export class FakeFiles implements LocalFiles {
	readonly files = new Set<string>();
	readonly ops: string[] = [];

	constructor(paths: string[] = []) {
		for (const p of paths) this.files.add(p);
	}
	list(): string[] {
		return [...this.files].sort();
	}
	exists(path: string): boolean {
		return this.files.has(path);
	}
	async create(path: string): Promise<void> {
		if (this.files.has(path)) throw new Error(`exists: ${path}`);
		this.ops.push(`create ${path}`);
		this.files.add(path);
	}
	async rename(from: string, to: string): Promise<void> {
		if (!this.files.has(from) || this.files.has(to)) throw new Error(`rename ${from} → ${to}`);
		this.ops.push(`rename ${from} → ${to}`);
		this.files.delete(from);
		this.files.add(to);
	}
	async trash(path: string): Promise<void> {
		this.ops.push(`trash ${path}`);
		this.files.delete(path);
	}
}

export class MemKnown implements KnownStore {
	constructor(public value: Record<string, string> = {}) {}
	load(): Record<string, string> {
		return { ...this.value };
	}
	save(known: Record<string, string>): void {
		this.value = { ...known };
	}
}

export const clock = { t: 1000 };

/** One vault: an index doc, a fake disk, `known`, and a reconciler wired like the session. */
export class Device {
	readonly doc = new Y.Doc();
	readonly index = new IndexStore(this.doc);
	readonly files: FakeFiles;
	readonly known: MemKnown;
	readonly reconciler: Reconciler;
	synced = true;
	acked = true;
	/** Local (non-remote) doc updates: what would become relay rows. */
	writes = 0;
	private seq = 0;

	constructor(
		readonly name: string,
		{ disk = [], known = {} }: { disk?: string[]; known?: Record<string, string> } = {},
	) {
		this.files = new FakeFiles(disk);
		this.known = new MemKnown(known);
		this.reconciler = new Reconciler({
			index: this.index,
			files: this.files,
			known: this.known,
			userId: name,
			isSynced: () => this.synced,
			isAcked: () => this.acked,
			now: () => clock.t,
			newId: () => `${name}${++this.seq}`,
		});
		this.index.observe((delta, local) => {
			if (!local) void this.reconciler.applyRemote(delta);
		});
		this.doc.on("update", (_u: Uint8Array, origin: unknown) => {
			if (origin !== REMOTE) this.writes++;
		});
	}

	meta(id: string, extra: Record<string, unknown> = {}) {
		return { id, kind: "md" as const, updatedBy: this.name, updatedAt: clock.t, ...extra };
	}

	idle(): Promise<void> {
		return this.reconciler.idle();
	}
}

/** Sends each doc what the other lacks, as a remote transaction. */
export function exchange(a: Device, b: Device): void {
	Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), REMOTE);
	Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)), REMOTE);
}

/**
 * Exchanges and drains until no device writes anything new; returns the rounds needed. Throws
 * if the devices keep writing (an echo loop).
 */
export async function settle(devices: Device[], maxRounds = 10): Promise<number> {
	for (let round = 1; round <= maxRounds; round++) {
		const before = devices.reduce((n, d) => n + d.writes, 0);
		for (const a of devices) for (const b of devices) if (a !== b) exchange(a, b);
		await Promise.all(devices.map((d) => d.idle()));
		await Promise.all(devices.map((d) => d.idle()));
		if (devices.reduce((n, d) => n + d.writes, 0) === before) return round;
	}
	throw new Error(`devices still writing after ${maxRounds} rounds`);
}

export function snapshot(d: Device): Record<string, string> {
	return Object.fromEntries(d.index.entries().map((e) => [e.path, e.meta.id]));
}
