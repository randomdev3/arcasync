import { CLONE_MAX_BYTES, decodeClone, docName } from "@arcasync/shared";
import { describe, expect, it } from "vitest";
import { CloneRateLimiter, cloneDocs } from "../src/clone";

const doc = (id: string, ws = "w1") => docName({ workspaceId: ws, kind: "md", fileId: id });

describe("CloneRateLimiter", () => {
	it("allows a burst of 10, then refills at 30 per minute", () => {
		let now = 0;
		const limiter = new CloneRateLimiter(undefined, undefined, () => now);
		for (let i = 0; i < 10; i++) expect(limiter.take("u")).toBe(0);
		expect(limiter.take("u")).toBe(2);
		expect(limiter.take("other")).toBe(0);
		now += 2000;
		expect(limiter.take("u")).toBe(0);
		expect(limiter.take("u")).toBeGreaterThan(0);
	});
});

describe("cloneDocs", () => {
	const third = Math.floor(CLONE_MAX_BYTES / 3) + 1;
	const store = { state: (name: string) => new Uint8Array(name.endsWith("big") ? third : 2) };

	it("stops before CLONE_MAX_BYTES and returns the rest as remaining", () => {
		const docs = ["a-big", "b-big", "c-big", "d"].map((id) => ({ doc: doc(id) }));
		const result = cloneDocs(store, "w1", { docs });
		if (!result.ok) throw new Error(result.message);
		const { entries, remaining } = decodeClone(result.body);
		expect(entries.map((e) => e.doc)).toEqual([doc("a-big"), doc("b-big")]);
		expect(remaining).toEqual([doc("c-big"), doc("d")]);
		expect(result.docs).toBe(2);
	});

	it("always returns the first doc, however large", () => {
		const huge = { state: () => new Uint8Array(CLONE_MAX_BYTES + 1) };
		const result = cloneDocs(huge, "w1", { docs: [{ doc: doc("x") }, { doc: doc("y") }] });
		if (!result.ok) throw new Error(result.message);
		expect(decodeClone(result.body).remaining).toEqual([doc("y")]);
	});

	it("refuses index docs, other workspaces and bad state vectors", () => {
		const index = docName({ workspaceId: "w1", kind: "index" });
		expect(cloneDocs(store, "w1", { docs: [{ doc: index }] }).ok).toBe(false);
		expect(cloneDocs(store, "w1", { docs: [{ doc: doc("a", "w2") }] }).ok).toBe(false);
		expect(cloneDocs(store, "w1", { docs: [{ doc: "nonsense" }] }).ok).toBe(false);
		expect(cloneDocs(store, "w1", { docs: [{ doc: doc("a"), sv: "%%%" }] }).ok).toBe(false);
	});
});
