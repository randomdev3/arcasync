import {
	installPresencePolicy,
	type PresencePolicy,
	userColor,
	type WorkspacePresence,
} from "@teamsync/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { avatarsFor } from "../presence/avatars";
import { IDLE_FLIP_MIN_MS, PresenceService, presenceUser } from "../presence/PresenceService";

const IDLE_AFTER = 300_000;
const alice = presenceUser({ id: "u-alice", name: "alice" });
const bob = presenceUser({ id: "u-bob", name: "bob" });

/** An awareness without y-protocols' 15 s renewal timer (the presence policy replaces it). */
function awareness(): Awareness {
	const a = new Awareness(new Y.Doc());
	clearInterval(a._checkInterval);
	return a;
}

/** Relays every update between the given awarenesses, like the relay does. */
function wire(...all: Awareness[]): void {
	for (const from of all) {
		type Changes = { added: number[]; updated: number[]; removed: number[] };
		from.on("update", ({ added, updated, removed }: Changes) => {
			const changed = [...added, ...updated, ...removed];
			const update = encodeAwarenessUpdate(from, changed);
			for (const to of all) if (to !== from) applyAwarenessUpdate(to, update, "remote");
		});
	}
}

/** Counts this client's own published updates. */
function countLocal(a: Awareness): { count: number } {
	const counter = { count: 0 };
	a.on("update", (_: unknown, origin: unknown) => {
		if (origin === "local") counter.count++;
	});
	return counter;
}

function service(a: Awareness, user = alice, extra: Partial<{ hidden: boolean }> = {}) {
	const onIdleChange = vi.fn();
	const s = new PresenceService({
		awareness: a,
		user,
		device: { id: `${user.name}-laptop`, platform: "desktop" },
		idleAfterMs: IDLE_AFTER,
		onIdleChange,
		...extra,
	});
	return { s, onIdleChange };
}

describe("PresenceService", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("publishes a valid WorkspacePresence that peers read back, grouped by user", () => {
		const [a, b] = [awareness(), awareness()];
		wire(a, b);
		const { s: sa } = service(a, alice);
		const { s: sb } = service(b, bob);
		sb.setFile("notes/x.md");

		const users = sa.users();
		expect([...users.keys()].sort()).toEqual(["u-alice", "u-bob"]);
		const [bobState] = users.get("u-bob") ?? [];
		expect(bobState).toMatchObject({
			user: { id: "u-bob", name: "bob", ...userColor("u-bob") },
			device: { id: "bob-laptop", platform: "desktop" },
			file: "notes/x.md",
			following: null,
			idle: false,
		});
		expect(sb.users().get("u-alice")?.[0]?.file).toBeNull();
	});

	it("groups several devices of one user under one key", () => {
		const [a, b1, b2] = [awareness(), awareness(), awareness()];
		wire(a, b1, b2);
		const { s } = service(a);
		new PresenceService({ awareness: b1, user: bob, device: { id: "d1", platform: "desktop" } });
		new PresenceService({ awareness: b2, user: bob, device: { id: "d2", platform: "mobile" } });

		const devices = s.users().get("u-bob") ?? [];
		expect(devices.map((d) => d.device.id).sort()).toEqual(["d1", "d2"]);
		expect(s.users().size).toBe(2);
	});

	it("ignores malformed and foreign states", () => {
		const [a, b, c, d] = [awareness(), awareness(), awareness(), awareness()];
		wire(a, b, c, d);
		const { s } = service(a);
		b.setLocalState({ user: { id: 7, name: "x" }, file: null });
		c.setLocalState({ cursor: { anchor: 1, head: 2 } });
		d.setLocalStateField("renewMs", 120_000);
		expect([...s.users().keys()]).toEqual(["u-alice"]);
	});

	it("keeps the policy's renewMs and publishes only real changes", () => {
		const a = awareness();
		a.setLocalStateField("renewMs", 120_000);
		const { s } = service(a);
		expect(a.getLocalState()?.renewMs).toBe(120_000);

		const local = countLocal(a);
		s.setFile("x.md");
		s.setFile("x.md");
		for (let i = 0; i < 100; i++) s.input();
		expect(local.count).toBe(1);
		expect(a.getLocalState()?.renewMs).toBe(120_000);
	});

	it("goes idle after the idle timeout without input, once", () => {
		const a = awareness();
		const { s, onIdleChange } = service(a);
		const local = countLocal(a);

		vi.advanceTimersByTime(IDLE_AFTER - 1000);
		s.input();
		vi.advanceTimersByTime(IDLE_AFTER - 1000);
		expect(s.idle).toBe(false);
		expect(local.count).toBe(0);

		vi.advanceTimersByTime(1000);
		expect(s.idle).toBe(true);
		expect(a.getLocalState()?.idle).toBe(true);
		expect(onIdleChange).toHaveBeenCalledTimes(1);
		expect(local.count).toBe(1);

		vi.advanceTimersByTime(10 * IDLE_AFTER);
		expect(local.count).toBe(1);
	});

	it("rate limits idle flips to one per minute, the first one immediate", () => {
		const a = awareness();
		const { s, onIdleChange } = service(a);
		const local = countLocal(a);

		s.setHidden(true);
		expect(s.idle).toBe(true);
		expect(local.count).toBe(1);

		// The window flaps every 5 s: at most one flip per IDLE_FLIP_MIN_MS gets published.
		for (let t = 0; t < 3 * IDLE_FLIP_MIN_MS; t += 5000) {
			s.setHidden(t % 10_000 !== 0);
			vi.advanceTimersByTime(5000);
		}
		expect(local.count).toBeLessThanOrEqual(1 + 3);
		expect(onIdleChange.mock.calls.length).toBe(local.count);

		// It settles on the latest state.
		s.setHidden(false);
		vi.advanceTimersByTime(IDLE_FLIP_MIN_MS);
		expect(s.idle).toBe(false);
	});

	it("starts idle in a hidden window and flips back as soon as it is shown", () => {
		const a = awareness();
		const { s, onIdleChange } = service(a, alice, { hidden: true });
		expect(s.idle).toBe(true);
		expect(a.getLocalState()?.idle).toBe(true);
		s.setHidden(false);
		expect(s.idle).toBe(false);
		expect(onIdleChange).toHaveBeenCalledTimes(1);
	});

	it("an idle flip and the policy's renewMs go out in the same tick", () => {
		const a = awareness();
		let policy: PresencePolicy | null = null;
		const s = new PresenceService({
			awareness: a,
			user: alice,
			device: { id: "d", platform: "desktop" },
			onIdleChange: () => policy?.refresh(),
		});
		policy = installPresencePolicy(a, {
			activeRenewMs: 120_000,
			idleRenewMs: 900_000,
			isIdle: () => s.idle,
		});
		s.setHidden(true);
		expect(a.getLocalState()).toMatchObject({ idle: true, renewMs: 900_000 });
		policy.dispose();
	});

	it("notifies on peer changes and drops a removed peer", () => {
		const [a, b] = [awareness(), awareness()];
		wire(a, b);
		const { s } = service(a);
		const listener = vi.fn();
		const off = s.onChange(listener);
		service(b, bob);
		expect(listener).toHaveBeenCalled();
		expect(s.users().has("u-bob")).toBe(true);

		b.setLocalState(null);
		expect(s.users().has("u-bob")).toBe(false);
		off();
	});

	it("dispose stops the idle timers", () => {
		const a = awareness();
		const { s } = service(a);
		s.dispose();
		vi.advanceTimersByTime(2 * IDLE_AFTER);
		expect(s.idle).toBe(false);
	});
});

describe("avatarsFor", () => {
	const at = (
		user: typeof alice,
		file: string | null,
		idle = false,
		device = "d",
	): WorkspacePresence => ({
		user,
		device: { id: device, platform: "desktop" },
		file,
		following: null,
		idle,
		ts: 0,
	});
	const carol = presenceUser({ id: "u-carol", name: "carol" });
	const dave = presenceUser({ id: "u-dave", name: "Dave Smith" });

	it("excludes self and orders here, elsewhere, idle", () => {
		const users = new Map([
			["u-alice", [at(alice, "x.md")]],
			["u-carol", [at(carol, "y.md", true)]],
			["u-dave", [at(dave, null)]],
			["u-bob", [at(bob, "x.md")]],
		]);
		const avatars = avatarsFor(users, "u-alice", "x.md", "Shared");
		expect(avatars.map((a) => [a.name, a.state, a.title])).toEqual([
			["bob", "here", "bob — Shared/x.md"],
			["Dave Smith", "elsewhere", "Dave Smith"],
			["carol", "idle", "carol — Shared/y.md"],
		]);
		expect(avatars[0]).toMatchObject({ userId: "u-bob", initials: "BO", color: bob.color });
		expect(avatars[1]?.initials).toBe("DS");
	});

	it("an idle peer on this note is idle, not here", () => {
		const users = new Map([["u-bob", [at(bob, "x.md", true)]]]);
		expect(avatarsFor(users, "u-alice", "x.md", "Shared")[0]?.state).toBe("idle");
	});

	it("a user on several devices shows once, at the most present device", () => {
		const users = new Map([
			["u-bob", [at(bob, "y.md", false, "laptop"), at(bob, "x.md", false, "phone")]],
		]);
		const avatars = avatarsFor(users, "u-alice", "x.md", "Shared");
		expect(avatars).toHaveLength(1);
		expect(avatars[0]).toMatchObject({ state: "here", title: "bob — Shared/x.md" });
		expect(avatarsFor(users, "u-alice", "z.md", "Shared")[0]).toMatchObject({
			state: "elsewhere",
			title: "bob — Shared/y.md",
		});
	});
});
