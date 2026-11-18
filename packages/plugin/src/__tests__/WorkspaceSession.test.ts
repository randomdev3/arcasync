import { describe, expect, it, vi } from "vitest";
import type { ConnectionManager, OpenDocHandle } from "../net/ConnectionManager";
import { WorkspaceSession } from "../workspace/WorkspaceSession";

// The note-doc layer needs a real vault and providers; it has its own tests.
vi.mock("../doc", () => ({ startNoteDocs: () => () => {} }));

function session() {
	const close = vi.fn();
	const openDoc = vi.fn(
		(): OpenDocHandle => ({ provider: {} as OpenDocHandle["provider"], presence: null, close }),
	);
	const s = new WorkspaceSession({
		app: {} as WorkspaceSession["app"],
		connections: { openDoc } as unknown as ConnectionManager,
		workspaceId: "ws1",
		root: "Shared",
		user: { id: "u1", name: "alice", color: "#fff" },
		vaultId: "vault1",
	});
	return { s, openDoc, close };
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
});
