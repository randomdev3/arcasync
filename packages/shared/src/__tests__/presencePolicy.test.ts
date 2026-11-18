import { afterEach, describe, expect, it, vi } from "vitest";

// lib0's `getUnixTime` is `Date.now` captured at import time, and Awareness stamps
// `meta.lastUpdated` with it. Fake timers must exist before y-protocols loads, or the
// Awareness clock and the fake clock disagree.
vi.hoisted(() => {
	vi.useFakeTimers();
});

import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { installPresencePolicy, type PresencePolicyOptions } from "../presencePolicy.js";

const S = 1000;
const ACTIVE = 120 * S;
const IDLE = 900 * S;

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup.splice(0)) fn();
});

function peer() {
	const doc = new Y.Doc();
	const awareness = new Awareness(doc);
	cleanup.push(() => doc.destroy());
	let localUpdates = 0;
	awareness.on("update", (_changes: unknown, origin: unknown) => {
		if (origin === "local") localUpdates += 1;
	});
	return {
		awareness,
		id: awareness.clientID,
		get localUpdates() {
			return localUpdates;
		},
	};
}

/** One-way relay of local changes from `from` to `to`; returns a function that cuts it. */
function link(from: Awareness, to: Awareness): () => void {
	let open = true;
	from.on(
		"update",
		(
			{ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
			origin: unknown,
		) => {
			if (!open || origin === "remote") return;
			const update = encodeAwarenessUpdate(from, [...added, ...updated, ...removed]);
			applyAwarenessUpdate(to, update, "remote");
		},
	);
	return () => {
		open = false;
	};
}

function policy(awareness: Awareness, options: Partial<PresencePolicyOptions> = {}) {
	return installPresencePolicy(awareness, {
		activeRenewMs: ACTIVE,
		idleRenewMs: IDLE,
		isIdle: () => false,
		...options,
	});
}

describe("installPresencePolicy", () => {
	it("active: renews at 120 s (not 15 s) and keeps a silent peer until 2.75 × 120 s", () => {
		const a = peer();
		const b = peer();
		link(a.awareness, b.awareness);
		const cutB = link(b.awareness, a.awareness);
		policy(a.awareness);
		policy(b.awareness);
		expect(a.awareness.getStates().get(b.id)?.renewMs).toBe(ACTIVE);
		cutB();
		const base = a.localUpdates;

		vi.advanceTimersByTime(15 * S);
		expect(a.localUpdates).toBe(base);
		vi.advanceTimersByTime(ACTIVE - 15 * S - 1);
		expect(a.localUpdates).toBe(base);
		vi.advanceTimersByTime(1);
		expect(a.localUpdates).toBe(base + 1);

		vi.advanceTimersByTime(300 * S - ACTIVE);
		expect(a.awareness.getStates().has(b.id)).toBe(true);
		vi.advanceTimersByTime(30 * S);
		expect(a.awareness.getStates().has(b.id)).toBe(false);
	});

	it("idle: renews at 900 s and keeps a silent peer past 2,400 s", () => {
		const a = peer();
		const b = peer();
		link(a.awareness, b.awareness);
		const cutB = link(b.awareness, a.awareness);
		policy(a.awareness, { isIdle: () => true });
		policy(b.awareness, { isIdle: () => true });
		expect(a.awareness.getStates().get(b.id)?.renewMs).toBe(IDLE);
		cutB();
		const base = a.localUpdates;

		vi.advanceTimersByTime(IDLE - 1);
		expect(a.localUpdates).toBe(base);
		vi.advanceTimersByTime(1);
		expect(a.localUpdates).toBe(base + 1);

		vi.advanceTimersByTime(2400 * S - IDLE);
		expect(a.awareness.getStates().has(b.id)).toBe(true);
		vi.advanceTimersByTime(90 * S);
		expect(a.awareness.getStates().has(b.id)).toBe(false);
	});

	it("expires a peer that advertises no renewMs after 30 s", () => {
		const a = peer();
		const b = peer();
		clearInterval(b.awareness._checkInterval);
		const cutB = link(b.awareness, a.awareness);
		policy(a.awareness);
		b.awareness.setLocalState({ user: "legacy" });
		cutB();

		vi.advanceTimersByTime(30 * S - 1);
		expect(a.awareness.getStates().has(b.id)).toBe(true);
		vi.advanceTimersByTime(1);
		expect(a.awareness.getStates().has(b.id)).toBe(false);
	});

	it("publishes exactly one update on an active → idle switch", () => {
		const a = peer();
		const b = peer();
		link(a.awareness, b.awareness);
		let idle = false;
		const p = policy(a.awareness, { isIdle: () => idle });
		const base = a.localUpdates;

		p.refresh();
		expect(a.localUpdates).toBe(base);
		idle = true;
		p.refresh();
		p.refresh();

		expect(a.localUpdates).toBe(base + 1);
		expect(p.renewMs).toBe(IDLE);
		expect(b.awareness.getStates().get(a.id)?.renewMs).toBe(IDLE);
	});

	it("clears the original y-protocols interval", () => {
		const a = peer();
		const original = a.awareness._checkInterval;
		const clear = vi.spyOn(globalThis, "clearInterval");

		policy(a.awareness);

		expect(clear).toHaveBeenCalledWith(original);
		clear.mockRestore();
	});

	it("re-advertises renewMs after a wholesale setLocalState", () => {
		const a = peer();
		const b = peer();
		link(a.awareness, b.awareness);
		policy(a.awareness);

		a.awareness.setLocalState(null);
		a.awareness.setLocalState({ user: { name: "alice" } });

		expect(a.awareness.getLocalState()).toEqual({ user: { name: "alice" }, renewMs: ACTIVE });
		expect(b.awareness.getStates().get(a.id)?.renewMs).toBe(ACTIVE);
	});

	it("disposes itself when the awareness is destroyed", () => {
		const a = peer();
		policy(a.awareness);
		const timers = vi.getTimerCount();

		a.awareness.destroy();

		expect(vi.getTimerCount()).toBe(timers - 1);
	});
});
