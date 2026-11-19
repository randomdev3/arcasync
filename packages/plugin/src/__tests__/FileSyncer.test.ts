import { CHUNK_BYTES, chunkFile, fileHash } from "@teamsync/shared";
import { Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limits } from "../platform";
import { clock, Device, MemChunks, settle } from "./indexHarness";

beforeEach(() => {
	clock.t = 1000;
});
afterEach(() => {
	Platform.isMobile = false;
});

/** Deterministic pseudo-random bytes (xorshift), so chunks differ from each other. */
function bytes(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n);
	let x = seed || 1;
	for (let i = 0; i < n; i++) {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		out[i] = x & 0xff;
	}
	return out;
}

async function started(...devices: Device[]): Promise<void> {
	for (const d of devices) await d.reconciler.run();
}

describe("FileSyncer upload", () => {
	it("uploads only missing chunks and indexes the file after its PUTs", async () => {
		const chunks = new MemChunks();
		const a = new Device("a", { chunks });
		await started(a);
		const data = bytes(9 * 1024 * 1024, 7);
		const [first] = await chunkFile(data);
		if (!first) throw new Error("no chunk");
		chunks.store.set(first.sha256, first.bytes);
		// Index writes and chunk requests on one timeline.
		a.index.observe(() => chunks.log.push("index"));

		a.files.edit("img.bin", data);
		await a.reconciler.localCreate("img.bin");
		await a.idle();

		const meta = a.index.get("img.bin");
		expect(meta).toMatchObject({
			kind: "binary",
			size: data.byteLength,
			mime: "application/octet-stream",
		});
		expect(meta?.chunks).toHaveLength(3);
		expect(meta?.hash).toBe(await fileHash(meta?.chunks ?? []));
		// 2 of 3 chunks are sent; the index entry comes after them, then the post-ack re-check.
		const short = (meta?.chunks ?? []).map((c) => c.slice(0, 8));
		expect(chunks.log).toEqual([
			"missing 3",
			`put ${short[1]}`,
			`put ${short[2]}`,
			"index",
			"missing 3",
		]);
	});

	it("re-uploads a chunk collected between the upload and the index ack", async () => {
		const chunks = new MemChunks();
		const a = new Device("a", { chunks });
		await started(a);
		a.acked = false;
		a.files.edit("x.png", bytes(1000, 3));
		await a.reconciler.localCreate("x.png");
		await a.idle();
		const sha = a.index.get("x.png")?.chunks?.[0] ?? "";
		expect(chunks.store.has(sha)).toBe(true);

		// GC raced the upload: the chunk is gone before the relay acked the index entry.
		chunks.store.delete(sha);
		a.ack();
		await a.idle();
		expect(chunks.store.has(sha)).toBe(true);
		expect(chunks.puts()).toBe(2);
	});

	it("does not upload or index anything for a viewer, and tells them once", async () => {
		const chunks = new MemChunks();
		const v = new Device("v", { chunks, readonly: true });
		await started(v);
		v.files.edit("carol.png", bytes(100, 4));
		await v.reconciler.localCreate("carol.png");
		await v.reconciler.run();
		await v.idle();
		expect(chunks.log).toEqual([]);
		expect(v.index.has("carol.png")).toBe(false);
		expect(v.notices).toHaveLength(1);
		expect(v.notices[0]).toMatch(/only view/);
	});

	it("skips a file over the mobile limit by its size alone, without reading it", async () => {
		Platform.isMobile = true;
		const chunks = new MemChunks();
		const m = new Device("m", { chunks, maxBytes: limits().maxBinaryBytes });
		await started(m);
		m.files.edit("video.mp4", bytes(10, 5));
		m.files.sizes.set("video.mp4", 60 * 1024 * 1024);
		let reads = 0;
		const read = m.files.readBinary.bind(m.files);
		m.files.readBinary = (p) => {
			reads++;
			return read(p);
		};
		await m.reconciler.localCreate("video.mp4");
		await m.idle();
		expect(reads).toBe(0);
		expect(chunks.log).toEqual([]);
		expect(m.index.has("video.mp4")).toBe(false);
		expect(m.notices[0]).toMatch(/larger than 50 MiB/);
	});
});

describe("FileSyncer download", () => {
	it("assembles a 9 MiB file of 3 chunks byte-identical", async () => {
		const chunks = new MemChunks();
		const a = new Device("a", { chunks });
		const b = new Device("b", { chunks });
		await started(a, b);
		const data = bytes(9 * 1024 * 1024, 11);
		expect(Math.ceil(data.byteLength / CHUNK_BYTES)).toBe(3);

		a.files.edit("big.bin", data);
		await a.reconciler.localCreate("big.bin");
		await settle([a, b]);

		// Not `toEqual`: a deep compare of 9 MiB element by element is very slow.
		expect(Buffer.from(b.files.bytes.get("big.bin") ?? []).equals(Buffer.from(data))).toBe(true);
		expect(b.files.ops).toEqual(["write big.bin"]);
		expect(chunks.log.filter((l) => l.startsWith("get"))).toHaveLength(3);
	});

	it("keeps a conflict copy only when the local file changed since it last synced", async () => {
		const chunks = new MemChunks();
		const a = new Device("a", { chunks });
		const b = new Device("b", { chunks });
		await started(a, b);
		a.files.edit("pic.png", bytes(500, 1));
		await a.reconciler.localCreate("pic.png");
		await settle([a, b]);

		// Unchanged here: a remote edit just replaces the file.
		const v2 = bytes(600, 2);
		a.files.edit("pic.png", v2);
		await a.reconciler.localModify("pic.png");
		await settle([a, b]);
		expect(b.files.bytes.get("pic.png")).toEqual(v2);
		expect(b.files.list()).toEqual(["pic.png"]);

		// Changed on both sides while apart: b keeps its bytes aside and takes a's.
		const ours = bytes(700, 3);
		const theirs = bytes(800, 4);
		a.files.edit("pic.png", theirs);
		b.files.edit("pic.png", ours);
		await a.reconciler.localModify("pic.png");
		await a.idle();
		await settle([a, b]);
		const copy = "pic (conflict b 202611191305).png";
		expect(b.files.list()).toEqual([copy, "pic.png"]);
		expect(b.files.bytes.get("pic.png")).toEqual(theirs);
		expect(b.files.bytes.get(copy)).toEqual(ours);
		expect(a.files.bytes.get(copy)).toEqual(ours);
		expect(a.files.bytes.get("pic.png")).toEqual(theirs);
	});

	it("waits for a missing chunk and retries on the next index change", async () => {
		const chunks = new MemChunks();
		const a = new Device("a", { chunks });
		const b = new Device("b", { chunks });
		await started(a, b);
		a.files.edit("w.png", bytes(300, 9));
		await a.reconciler.localCreate("w.png");
		await a.idle();
		const sha = a.index.get("w.png")?.chunks?.[0] ?? "";
		const saved = chunks.store.get(sha);
		chunks.store.delete(sha);
		await settle([a, b]);
		expect(b.files.exists("w.png")).toBe(false);
		expect(b.notices).toEqual(["TeamSync: w.png: waiting for upload"]);

		if (saved) chunks.store.set(sha, saved);
		a.files.edit("other.md", new Uint8Array());
		await a.reconciler.localCreate("other.md");
		await settle([a, b]);
		expect(b.files.bytes.get("w.png")).toEqual(bytes(300, 9));
	});
});
