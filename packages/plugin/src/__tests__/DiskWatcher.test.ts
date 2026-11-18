import { TFile, TFolder, type Vault } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiskWatcher } from "../workspace/DiskWatcher";
import { SelfWriteRegistry } from "../workspace/SelfWriteRegistry";

type Handler = (...args: unknown[]) => void;

class FakeVault {
	readonly handlers = new Map<string, Set<Handler>>();
	on(name: string, cb: Handler) {
		const set = this.handlers.get(name) ?? new Set();
		set.add(cb);
		this.handlers.set(name, set);
		return { name, cb };
	}
	offref(ref: { name: string; cb: Handler }) {
		this.handlers.get(ref.name)?.delete(ref.cb);
	}
	emit(name: string, ...args: unknown[]) {
		for (const cb of this.handlers.get(name) ?? []) cb(...args);
	}
}

function file(path: string): TFile {
	const f = new TFile();
	f.path = path;
	return f;
}

function setup() {
	const vault = new FakeVault();
	const selfWrites = new SelfWriteRegistry();
	const log: string[] = [];
	const watcher = new DiskWatcher(vault as unknown as Vault, "Shared", selfWrites, {
		create: (p) => log.push(`create ${p}`),
		delete: (p) => log.push(`delete ${p}`),
		rename: (a, b) => log.push(`rename ${a} → ${b}`),
		modify: (p) => log.push(`modify ${p}`),
	});
	watcher.start();
	return { vault, selfWrites, log, watcher };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("DiskWatcher", () => {
	it("announces a new note only after it has existed for 500 ms", () => {
		const { vault, log } = setup();
		vault.emit("create", file("Shared/a.md"));
		vi.advanceTimersByTime(499);
		expect(log).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(log).toEqual(["create a.md"]);
	});

	it("drops a note deleted or renamed inside the debounce window", () => {
		const { vault, log } = setup();
		vault.emit("create", file("Shared/tmp.md"));
		vault.emit("delete", file("Shared/tmp.md"));
		vault.emit("create", file("Shared/Untitled.md"));
		vault.emit("rename", file("Shared/Named.md"), "Shared/Untitled.md");
		vi.advanceTimersByTime(1000);
		expect(log).toEqual(["create Named.md"]);
	});

	it("drops events TeamSync caused itself, at event time", () => {
		const { vault, selfWrites, log } = setup();
		selfWrites.expect("Shared/r.md", { kind: "create" });
		selfWrites.expect("Shared/r.md", { kind: "modify" });
		selfWrites.expect("Shared/moved.md", { kind: "rename" });
		selfWrites.expect("Shared/gone.md", { kind: "delete" });
		vault.emit("create", file("Shared/r.md"));
		vault.emit("modify", file("Shared/r.md"));
		vault.emit("rename", file("Shared/moved.md"), "Shared/r.md");
		vault.emit("delete", file("Shared/gone.md"));
		vi.advanceTimersByTime(1000);
		expect(log).toEqual([]);
		expect(selfWrites.size).toBe(0);
	});

	it("reports user modifies, renames and deletes", () => {
		const { vault, log } = setup();
		vault.emit("modify", file("Shared/x.md"));
		vault.emit("rename", file("Shared/dir/y.md"), "Shared/x.md");
		vault.emit("delete", file("Shared/dir/y.md"));
		expect(log).toEqual(["modify x.md", "rename x.md → dir/y.md", "delete dir/y.md"]);
	});

	it("treats renames across the folder boundary as delete or create", () => {
		const { vault, selfWrites, log } = setup();
		vault.emit("rename", file("Elsewhere/out.md"), "Shared/out.md");
		vault.emit("rename", file("Shared/in.md"), "Elsewhere/in.md");
		// Obsidian's local trash: a rename into `.trash` that TeamSync asked for.
		selfWrites.expect("Shared/t.md", { kind: "delete" });
		vault.emit("rename", file(".trash/t.md"), "Shared/t.md");
		vi.advanceTimersByTime(500);
		expect(log).toEqual(["delete out.md", "create in.md"]);
	});

	it("ignores folders, other kinds and paths outside the folder", () => {
		const { vault, log } = setup();
		const folder = new TFolder();
		folder.path = "Shared/dir";
		vault.emit("create", folder);
		vault.emit("create", file("Shared/img.png"));
		vault.emit("create", file("Shared/d.excalidraw.md"));
		vault.emit("create", file("Other/a.md"));
		vault.emit("modify", file("Shared/.hidden/a.md"));
		vi.advanceTimersByTime(1000);
		expect(log).toEqual([]);
	});

	it("stop() unregisters every handler and pending timer", () => {
		const { vault, log, watcher } = setup();
		vault.emit("create", file("Shared/a.md"));
		watcher.stop();
		vi.advanceTimersByTime(1000);
		vault.emit("modify", file("Shared/a.md"));
		expect(log).toEqual([]);
		expect([...vault.handlers.values()].every((s) => s.size === 0)).toBe(true);
	});
});
