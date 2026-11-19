import { describe, expect, it } from "vitest";
import { cachedResult, createMeCache } from "../src/meCache";

type Result<T> = { ok: true; value: T } | { ok: false; error: { status: number; code: string } };

function fakeClock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("meCache", () => {
	it("serves a value until its TTL, then misses", () => {
		const clock = fakeClock();
		const cache = createMeCache<string>({ ttlMs: 60_000, max: 256, now: clock.now });
		cache.set("t", "me");
		clock.advance(59_999);
		expect(cache.get("t")).toBe("me");
		clock.advance(1);
		expect(cache.get("t")).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	it("is bounded to `max` entries, evicting the least recently used", () => {
		const cache = createMeCache<number>({ ttlMs: 60_000, max: 256 });
		for (let i = 0; i < 256; i++) cache.set(`t${i}`, i);
		expect(cache.get("t0")).toBe(0); // t0 is now the most recently used
		cache.set("t256", 256);
		expect(cache.size).toBe(256);
		expect(cache.get("t1")).toBeUndefined();
		expect(cache.get("t0")).toBe(0);
		expect(cache.get("t256")).toBe(256);
		for (let i = 300; i < 1000; i++) cache.set(`t${i}`, i);
		expect(cache.size).toBe(256);
	});

	it("drops an entry", () => {
		const cache = createMeCache<string>({ ttlMs: 60_000, max: 256 });
		cache.set("t", "me");
		cache.drop("t");
		expect(cache.get("t")).toBeUndefined();
		cache.drop("unknown");
	});

	it("caches successful results only", async () => {
		const cache = createMeCache<string>({ ttlMs: 60_000, max: 256 });
		let calls = 0;
		const failing = async (): Promise<Result<string>> => {
			calls += 1;
			return { ok: false, error: { status: 401, code: "unauthorized" } };
		};
		expect((await cachedResult(cache, "bad", failing)).ok).toBe(false);
		expect((await cachedResult(cache, "bad", failing)).ok).toBe(false);
		expect(calls).toBe(2);
		expect(cache.size).toBe(0);

		const succeeding = async (): Promise<Result<string>> => {
			calls += 1;
			return { ok: true, value: "me" };
		};
		expect(await cachedResult(cache, "good", succeeding)).toEqual({ ok: true, value: "me" });
		expect(await cachedResult(cache, "good", succeeding)).toEqual({ ok: true, value: "me" });
		expect(calls).toBe(3);
	});
});
