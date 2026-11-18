import { userColor, type WorkspacePresence } from "@teamsync/shared";
import { describe, expect, it, vi } from "vitest";
import { Navigator, type NavigatorPort } from "../presence/Navigator";
import type { IPresence } from "../workspace/types";

function place(id: string, file: string | null, extra: Partial<WorkspacePresence> = {}) {
	return {
		user: { id, name: id.replace(/^u-/, ""), ...userColor(id) },
		device: { id: `${id}-laptop`, platform: "desktop" },
		file,
		following: null,
		idle: false,
		ts: 1,
		...extra,
	} satisfies WorkspacePresence;
}

/** Presence the test edits directly; `set` notifies like an awareness change. */
function fakePresence() {
	const users = new Map<string, WorkspacePresence[]>();
	const listeners = new Set<() => void>();
	const presence: IPresence = {
		users: () => new Map(users),
		onChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		idle: false,
	};
	return {
		presence,
		listeners,
		set(id: string, devices: WorkspacePresence[] | null) {
			if (devices) users.set(id, devices);
			else users.delete(id);
			for (const listener of [...listeners]) listener();
		},
	};
}

/** A workspace that opens notes instantly (or when released) and records what happened. */
function fakePort() {
	const fileOpen = new Set<(file: string | null) => void>();
	const keydown = new Set<() => void>();
	const notices: string[] = [];
	const tracking: string[] = [];
	let gate: Promise<void> | null = null;
	const port = {
		open: vi.fn(async (file: string) => {
			if (gate) await gate;
			if (file === "missing.md") return false;
			for (const listener of [...fileOpen]) listener(file);
			return true;
		}),
		reveal: vi.fn(async (_file: string, _userId: string) => true),
		trackCursor: vi.fn((file: string) => {
			tracking.push(file);
			return () => {
				tracking.splice(tracking.indexOf(file), 1);
			};
		}),
		onFileOpen: (listener: (file: string | null) => void) => {
			fileOpen.add(listener);
			return () => fileOpen.delete(listener);
		},
		onEditorKeydown: (listener: () => void) => {
			keydown.add(listener);
			return () => keydown.delete(listener);
		},
		bookmark: () => null,
		notify: (message: string) => {
			notices.push(message);
		},
	} satisfies NavigatorPort;
	return {
		port,
		notices,
		tracking,
		/** Holds every `open` until the returned function runs. */
		hold() {
			let release = () => {};
			gate = new Promise((resolve) => {
				release = () => {
					gate = null;
					resolve();
				};
			});
			return release;
		},
		userOpens(file: string | null) {
			for (const listener of [...fileOpen]) listener(file);
		},
		keydown() {
			for (const listener of [...keydown]) listener();
		},
		listeners: () => fileOpen.size + keydown.size,
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
	const presence = fakePresence();
	const port = fakePort();
	const published: Array<string | null> = [];
	const navigator = new Navigator({
		presence: presence.presence,
		selfId: "u-alice",
		port: port.port,
		publishFollowing: (id) => published.push(id),
	});
	presence.set("u-alice", [place("u-alice", "a.md")]);
	presence.set("u-bob", [place("u-bob", "far.md")]);
	return { navigator, presence, port, published };
}

describe("Navigator", () => {
	it("jumpTo opens the target's note and reveals their caret", async () => {
		const { navigator, port } = setup();
		await navigator.jumpTo("u-bob");
		expect(port.port.open).toHaveBeenCalledWith("far.md");
		expect(port.port.reveal).toHaveBeenCalledWith("far.md", "u-bob");
		expect(port.notices).toEqual(["Jumped to bob"]);
		expect(navigator.following).toBeNull();
	});

	it("jumpTo explains a hidden caret, a missing note and a user outside the folder", async () => {
		const { navigator, presence, port } = setup();
		port.port.reveal.mockResolvedValueOnce(false);
		await navigator.jumpTo("u-bob");
		presence.set("u-bob", [place("u-bob", "missing.md")]);
		await navigator.jumpTo("u-bob");
		presence.set("u-bob", [place("u-bob", null)]);
		await navigator.jumpTo("u-bob");
		await navigator.jumpTo("u-carol");
		expect(port.notices).toEqual([
			"bob's cursor is not visible",
			"bob's note is not in this vault yet",
			"bob is not in a shared note",
			"That user is not online",
		]);
	});

	it("goes to the most recently switched active device", async () => {
		const { navigator, presence, port } = setup();
		presence.set("u-bob", [
			place("u-bob", "old.md", { ts: 5 }),
			place("u-bob", "new.md", { ts: 9, device: { id: "phone", platform: "mobile" } }),
			place("u-bob", "idle.md", { ts: 20, idle: true, device: { id: "pc", platform: "desktop" } }),
		]);
		await navigator.jumpTo("u-bob");
		expect(port.port.open).toHaveBeenCalledWith("new.md");
	});

	it("follow publishes once, tracks the target across notes and their caret", async () => {
		const { navigator, presence, port, published } = setup();
		const changes = vi.fn();
		navigator.onChange(changes);
		navigator.follow("u-bob");
		navigator.follow("u-bob");
		expect(navigator.following).toBe("u-bob");
		expect(navigator.followedUser?.name).toBe("bob");
		expect(published).toEqual(["u-bob"]);
		expect(changes).toHaveBeenCalledTimes(1);
		await flush();
		expect(port.tracking).toEqual(["far.md"]);

		for (const file of ["f1.md", "f2.md", "f3.md"]) {
			presence.set("u-bob", [place("u-bob", file)]);
			await flush();
			expect(port.tracking).toEqual([file]);
		}
		expect(port.port.open.mock.calls.map(([f]) => f)).toEqual([
			"far.md",
			"f1.md",
			"f2.md",
			"f3.md",
		]);
		// An unrelated presence change (alice's own) navigates nowhere.
		presence.set("u-alice", [place("u-alice", "f3.md")]);
		await flush();
		expect(port.port.open).toHaveBeenCalledTimes(4);
		expect(navigator.following).toBe("u-bob");
		expect(port.notices).toEqual([]);
		expect(published).toEqual(["u-bob"]);
	});

	it("a real key press in an editor stops following, with a notice", async () => {
		const { navigator, port, published } = setup();
		navigator.follow("u-bob");
		await flush();
		port.keydown();
		expect(navigator.following).toBeNull();
		expect(port.notices).toEqual(["Stopped following bob"]);
		expect(published).toEqual(["u-bob", null]);
		expect(port.tracking).toEqual([]);
		expect(port.listeners()).toBe(0);
	});

	it("a note the user opens stops following; the Navigator's own opens do not", async () => {
		const { navigator, presence, port } = setup();
		navigator.follow("u-bob");
		await flush();
		presence.set("u-bob", [place("u-bob", "f1.md")]);
		await flush();
		// Obsidian may report the Navigator's open again (focus change, late event).
		port.userOpens("f1.md");
		expect(navigator.following).toBe("u-bob");
		port.userOpens("other.md");
		expect(navigator.following).toBeNull();
		expect(port.notices).toEqual(["Stopped following bob"]);
	});

	it("closing every note (file-open null) stops following", async () => {
		const { navigator, port } = setup();
		navigator.follow("u-bob");
		await flush();
		port.userOpens(null);
		expect(navigator.following).toBeNull();
	});

	it("stops when the target goes offline", async () => {
		const { navigator, presence, port, published } = setup();
		navigator.follow("u-bob");
		await flush();
		presence.set("u-bob", null);
		expect(navigator.following).toBeNull();
		expect(port.notices).toEqual(["Stopped following bob: bob went offline"]);
		expect(published).toEqual(["u-bob", null]);
		expect(presence.listeners.size).toBe(0);
	});

	it("a superseded hop gives up; only the latest note is tracked", async () => {
		const { navigator, presence, port } = setup();
		navigator.follow("u-bob");
		await flush();
		const release = port.hold();
		presence.set("u-bob", [place("u-bob", "f1.md")]);
		presence.set("u-bob", [place("u-bob", "f2.md")]);
		release();
		await flush();
		expect(port.port.reveal.mock.calls.map(([f]) => f)).toEqual(["far.md", "f2.md"]);
		expect(port.tracking).toEqual(["f2.md"]);
		expect(navigator.following).toBe("u-bob");
	});

	it("waits on a target outside the folder and picks up their next note", async () => {
		const { navigator, presence, port } = setup();
		navigator.follow("u-bob");
		await flush();
		presence.set("u-bob", [place("u-bob", null)]);
		await flush();
		expect(navigator.following).toBe("u-bob");
		presence.set("u-bob", [place("u-bob", "f1.md")]);
		await flush();
		expect(port.tracking).toEqual(["f1.md"]);
	});

	it("unfollow is silent; jumping to someone else stops following them", async () => {
		const { navigator, presence, port, published } = setup();
		navigator.follow("u-bob");
		navigator.unfollow();
		expect(port.notices).toEqual([]);
		expect(published).toEqual(["u-bob", null]);

		presence.set("u-carol", [place("u-carol", "c.md")]);
		navigator.follow("u-bob");
		await navigator.jumpTo("u-carol");
		expect(navigator.following).toBeNull();
		expect(port.notices).toEqual(["Stopped following bob", "Jumped to carol"]);
	});

	it("jumping to the followed user keeps following and tracking", async () => {
		const { navigator, port } = setup();
		navigator.follow("u-bob");
		await flush();
		await navigator.jumpTo("u-bob");
		expect(navigator.following).toBe("u-bob");
		expect(port.tracking).toEqual(["far.md"]);
	});

	it("never follows itself; dispose stops without publishing", async () => {
		const { navigator, port, published } = setup();
		navigator.follow("u-alice");
		expect(navigator.following).toBeNull();
		navigator.follow("u-bob");
		await flush();
		navigator.dispose();
		expect(navigator.following).toBeNull();
		expect(published).toEqual(["u-bob"]);
		expect(port.tracking).toEqual([]);
		expect(port.listeners()).toBe(0);
		navigator.follow("u-bob");
		expect(navigator.following).toBeNull();
	});
});
