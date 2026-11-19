import { describe, expect, it } from "vitest";
import { type GcBucket, runChunkGc } from "../src/gc";

const HOUR = 3_600_000;
const NOW = 100 * HOUR;
const PREFIX = "ws/w1/";

/** In-memory bucket with R2's list paging (`limit`, `cursor`, `truncated`). */
function fakeBucket(objects: Record<string, number>) {
	const store = new Map(Object.entries(objects).map(([sha, at]) => [PREFIX + sha, at]));
	const calls = { list: 0, delete: 0 };
	const bucket: GcBucket = {
		async list({ prefix, cursor, limit = 1000 }) {
			calls.list += 1;
			const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
			const start = cursor ? Number(cursor) : 0;
			const page = keys.slice(start, start + limit);
			const next = start + page.length;
			return {
				objects: page.map((key) => ({ key, uploaded: new Date(store.get(key) ?? 0) })),
				...(next < keys.length ? { truncated: true, cursor: String(next) } : { truncated: false }),
			};
		},
		async delete(keys) {
			calls.delete += 1;
			for (const k of keys) store.delete(k);
		},
	};
	return { bucket, store, calls };
}

const keys = (store: Map<string, number>) =>
	[...store.keys()].map((k) => k.slice(PREFIX.length)).sort();

describe("runChunkGc", () => {
	it("deletes old unreferenced objects and keeps young or referenced ones", async () => {
		const { bucket, store } = fakeBucket({ old: NOW - 2 * 24 * HOUR, young: NOW - HOUR, used: 0 });
		const result = await runChunkGc({
			bucket,
			prefix: PREFIX,
			project: () => new Set(["used"]),
			now: NOW,
			graceMs: 24 * HOUR,
		});
		expect(result).toEqual({ listed: 3, deleted: 1, kept: 2, capped: false });
		expect(keys(store)).toEqual(["used", "young"]);
	});

	it("keeps an object referenced only in the second projection (race guard)", async () => {
		const { bucket, store } = fakeBucket({ a: 0, b: 0 });
		const projections = [new Set<string>(), new Set(["b"])];
		const result = await runChunkGc({
			bucket,
			prefix: PREFIX,
			project: () => projections.shift() ?? new Set(),
			now: NOW,
			graceMs: HOUR,
		});
		expect(result.deleted).toBe(1);
		expect(keys(store)).toEqual(["b"]);
	});

	it("caps the listing and re-arms exactly once", async () => {
		const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`s${i}`, 0]));
		const { bucket, store, calls } = fakeBucket(many);
		const rearms: number[] = [];
		const result = await runChunkGc({
			bucket,
			prefix: PREFIX,
			project: () => new Set(),
			now: NOW,
			graceMs: HOUR,
			maxPages: 2,
			pageSize: 10,
			rearm: (at) => {
				rearms.push(at);
			},
		});
		expect(result).toEqual({ listed: 20, deleted: 20, kept: 0, capped: true });
		expect(calls.list).toBe(2);
		expect(rearms).toEqual([NOW + HOUR]);
		expect(store.size).toBe(5);

		const done = await runChunkGc({
			bucket,
			prefix: PREFIX,
			project: () => new Set(),
			now: NOW,
			graceMs: HOUR,
			maxPages: 2,
			pageSize: 10,
			rearm: (at) => {
				rearms.push(at);
			},
		});
		expect(done.capped).toBe(false);
		expect(rearms).toHaveLength(1);
		expect(store.size).toBe(0);
	});

	it("deletes in batches of at most 1000 keys", async () => {
		const many = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`s${i}`, 0]));
		const { bucket, calls } = fakeBucket(many);
		const result = await runChunkGc({
			bucket,
			prefix: PREFIX,
			project: () => new Set(),
			now: NOW,
			graceMs: HOUR,
		});
		expect(result.deleted).toBe(2500);
		expect(calls.delete).toBe(3);
	});

	it("does nothing on an empty bucket", async () => {
		const { bucket, calls } = fakeBucket({});
		const result = await runChunkGc({
			bucket,
			prefix: PREFIX,
			project: () => new Set(),
			now: NOW,
			graceMs: HOUR,
		});
		expect(result).toEqual({ listed: 0, deleted: 0, kept: 0, capped: false });
		expect(calls.delete).toBe(0);
	});
});
