import { describe, expect, it, vi } from "vitest";
import type { ConnectionManager, OpenDocHandle } from "../net/ConnectionManager";
import { WorkspaceSession } from "../workspace/WorkspaceSession";

// The note-doc layer needs a real vault and providers; it has its own tests.
vi.mock("../doc", () => ({ startNoteDocs: () => () => {} }));
// Presence needs Obsidian's workspace and DOM; it has its own tests.
vi.mock("../presence", () => ({ startPresence: () => () => {} }));

/** Counts live listeners on the fake vault and provider, to prove stop() removes them all. */
function fakes() {
	const listeners = { vault: 0, provider: 0 };
	const vault = {
		on: () => {
			listeners.vault++;
			return {};
		},
		offref: () => {
			listeners.vault--;
		},
		getMarkdownFiles: () => [],
	};
	const provider = {
		synced: false,
		hasUnsyncedChanges: false,
		on: () => {
			listeners.provider++;
		},
		off: () => {
			listeners.provider--;
		},
	};
	return { listeners, vault, provider };
}

function session(root: string | null = "Shared") {
	const { listeners, vault, provider } = fakes();
	const close = vi.fn();
	const openDoc = vi.fn(
		(): OpenDocHandle => ({
			provider: provider as unknown as OpenDocHandle["provider"],
			presence: null,
			close,
		}),
	);
	const s = new WorkspaceSession({
		app: { vault } as unknown as WorkspaceSession["app"],
		connections: { openDoc } as unknown as ConnectionManager,
		workspaceId: "ws1",
		root,
		user: { id: "u1", name: "alice", color: "#fff" },
		vaultId: "vault1",
	});
	return { s, openDoc, close, listeners };
}

describe("WorkspaceSession", () => {
	it("attaches the index doc with its awareness on start, once", () => {
		const { s, openDoc } = session();
		expect(s.started).toBe(false);
		expect(() => s.indexDoc).toThrow();
		s.start();
		s.start();
		expect(openDoc).toHaveBeenCalledTimes(1);
		expect(openDoc).toHaveBeenCalledWith("ws:ws1:index", s.indexDoc, s.awareness);
		expect(s.awareness.doc).toBe(s.indexDoc);
		expect(s.root).toBe("Shared");
	});

	it("stop() detaches and a restart uses a fresh doc and awareness", () => {
		const { s, openDoc, close } = session();
		s.start();
		const first = s.indexDoc;
		s.selfWrites.expect("Shared/a.md", { kind: "create" });
		s.stop();
		expect(close).toHaveBeenCalledTimes(1);
		expect(s.started).toBe(false);
		expect(s.selfWrites.size).toBe(0);
		s.start();
		expect(openDoc).toHaveBeenCalledTimes(2);
		expect(s.indexDoc).not.toBe(first);
	});

	it("watches the mapped folder only while started", () => {
		const { s, listeners } = session();
		s.start();
		expect(listeners).toEqual({ vault: 4, provider: 2 });
		expect(s.index).not.toBeNull();
		s.stop();
		expect(listeners).toEqual({ vault: 0, provider: 0 });
		expect(s.index).toBeNull();
		s.start();
		expect(listeners).toEqual({ vault: 4, provider: 2 });
	});

	it("keeps the index store but syncs no folder when none is mapped", () => {
		const { s, listeners } = session(null);
		s.start();
		expect(listeners).toEqual({ vault: 0, provider: 0 });
		s.indexDoc.getMap("files").set("a.md", { id: "A", kind: "md", updatedBy: "u", updatedAt: 1 });
		expect(s.index?.get("a.md")?.id).toBe("A");
		expect(s.fileIdOf("Shared/a.md")).toBeNull();
	});
});
