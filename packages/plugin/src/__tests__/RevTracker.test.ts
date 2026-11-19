import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { RevTracker } from "../doc/RevTracker";
import { FakeProvider, MemoryStorage } from "./helpers/noteFakes";

const HOUR = 3_600_000;

function setup(options: { userId?: string; storage?: MemoryStorage; now?: () => number } = {}) {
	const index = new Y.Doc();
	const revs = index.getMap<unknown>("docRevs");
	const storage = options.storage ?? new MemoryStorage();
	const tracker = new RevTracker({
		revs,
		userId: options.userId ?? "alice",
		storage,
		keyPrefix: "teamsync:v:ws",
		now: options.now ?? (() => Date.now()),
	});
	return { index, revs, storage, tracker };
}

function note(fileId = "n1") {
	const ydoc = new Y.Doc();
	const provider = new FakeProvider();
	provider.synced = true;
	return { fileId, ydoc, provider, text: ydoc.getText("contents") };
}

describe("RevTracker", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
	});
	afterEach(() => vi.useRealTimers());

	it("bumps once the relay acked local changes, not for remote ones", () => {
		const { revs, tracker } = setup();
		const n = note();
		tracker.track(n);
		n.ydoc.transact(() => n.text.insert(0, "remote"), n.provider);
		n.provider.setUnsynced(0);
		expect(revs.get("n1")).toBeUndefined();

		n.text.insert(0, "local ");
		n.provider.setUnsynced(1);
		expect(revs.get("n1")).toBeUndefined();
		n.provider.setUnsynced(0);
		expect(revs.get("n1")).toEqual({ at: Date.now(), by: "alice" });
		expect(tracker.dirty()).toEqual([]);
		// Our own bump is not a change to catch up with.
		expect(tracker.changed()).toEqual([]);
	});

	it("an observer of docRevs already sees its own bump as caught up", () => {
		const { revs, tracker } = setup();
		const n = note();
		tracker.track(n);
		const seen: boolean[] = [];
		// BackgroundSync queues notes from this observer; a self-bump must not re-attach a note.
		revs.observe(() => seen.push(tracker.isChanged("n1")));
		n.text.insert(0, "local");
		n.provider.setUnsynced(1);
		n.provider.setUnsynced(0);
		expect(seen).toEqual([false]);
	});

	it("throttles to one bump per 5 s per note, with one trailing bump", () => {
		const { revs, tracker } = setup();
		const n = note();
		tracker.track(n);
		const sets: unknown[] = [];
		revs.observe(() => sets.push(revs.get("n1")));
		const edit = () => {
			n.text.insert(0, "x");
			n.provider.setUnsynced(1);
			n.provider.setUnsynced(0);
		};
		edit();
		expect(sets).toHaveLength(1);
		vi.advanceTimersByTime(1000);
		edit();
		vi.advanceTimersByTime(1000);
		edit();
		expect(sets).toHaveLength(1);
		vi.advanceTimersByTime(2999);
		expect(sets).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(sets).toHaveLength(2);
		vi.advanceTimersByTime(60_000);
		expect(sets).toHaveLength(2);
		expect(tracker.dirty()).toEqual([]);
	});

	it("keeps the note dirty when changes arrive after the ack the trailing bump was for", () => {
		const { revs, tracker } = setup();
		const n = note();
		tracker.track(n);
		n.text.insert(0, "a");
		n.provider.setUnsynced(1);
		n.provider.setUnsynced(0);
		n.text.insert(0, "b");
		n.provider.setUnsynced(1);
		n.provider.setUnsynced(0); // schedules the trailing bump
		n.text.insert(0, "c");
		n.provider.setUnsynced(1); // not acked yet when the trailing bump fires
		vi.advanceTimersByTime(5000);
		expect(tracker.dirty()).toEqual(["n1"]);
		n.provider.setUnsynced(0);
		vi.advanceTimersByTime(5000);
		expect(tracker.dirty()).toEqual([]);
		expect(revs.get("n1")).toEqual({ at: Date.now(), by: "alice" });
	});

	it("persists local changes until they are announced, across a restart", () => {
		const storage = new MemoryStorage();
		const first = setup({ storage });
		const n = note();
		first.tracker.track(n);
		n.text.insert(0, "offline edit");
		expect(first.tracker.dirty()).toEqual(["n1"]);

		const second = setup({ storage });
		expect(second.tracker.dirty()).toEqual(["n1"]);
		const again = note();
		again.provider.unsyncedChanges = 0;
		second.tracker.track(again);
		expect(second.revs.get("n1")).toMatchObject({ by: "alice" });
		expect(second.tracker.dirty()).toEqual([]);
	});

	it("changed() compares rev values, so a peer clock an hour behind still counts", () => {
		const peerNow = () => Date.now() - HOUR;
		const shared = new Y.Doc();
		const reader = new RevTracker({
			revs: shared.getMap("docRevs"),
			userId: "bob",
			storage: new MemoryStorage(),
			keyPrefix: "teamsync:b:ws",
		});
		const writer = new RevTracker({
			revs: shared.getMap("docRevs"),
			userId: "alice",
			storage: new MemoryStorage(),
			keyPrefix: "teamsync:a:ws",
			now: peerNow,
		});
		const n = note();
		writer.track(n);
		n.text.insert(0, "one");
		n.provider.setUnsynced(0);
		expect(reader.changed()).toEqual(["n1"]);
		reader.markSynced("n1", reader.rev("n1"));
		expect(reader.changed()).toEqual([]);

		vi.advanceTimersByTime(10_000);
		n.text.insert(0, "two");
		n.provider.setUnsynced(0);
		const rev = reader.rev("n1");
		// The new rev is still an hour older than the reader's clock, yet it is a change.
		expect(rev?.at).toBeLessThan(Date.now() - HOUR + 60_000);
		expect(reader.changed()).toEqual(["n1"]);
	});

	it("isKnown/markSynced survive a restart, including notes without a rev", () => {
		const storage = new MemoryStorage();
		const { tracker } = setup({ storage });
		tracker.markSynced("n1", null);
		tracker.markSynced("n2", { at: 1, by: "bob" });
		const { tracker: again } = setup({ storage });
		expect(again.isKnown("n1")).toBe(true);
		expect(again.syncedRev("n2")).toEqual({ at: 1, by: "bob" });
		expect(again.isKnown("n3")).toBe(false);
	});

	it("ignores malformed rev values", () => {
		const { revs, tracker } = setup();
		revs.set("bad", { at: "yesterday" });
		expect(tracker.rev("bad")).toBeNull();
		expect(tracker.changed()).toEqual([]);
	});
});
