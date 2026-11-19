import { sha256Hex } from "@arcasync/shared";
import { describe, expect, it } from "vitest";
import { DiskWriter } from "../doc/DiskWriter";
import { SelfWriteRegistry } from "../workspace/SelfWriteRegistry";
import { FakeDisk } from "./helpers/noteFakes";

function writer(files: Record<string, string>) {
	const disk = new FakeDisk(files);
	const selfWrites = new SelfWriteRegistry();
	return { disk, selfWrites, w: new DiskWriter(disk, selfWrites) };
}

describe("DiskWriter", () => {
	it("runs writes to one path in call order", async () => {
		const { disk, w } = writer({ "a.md": "0" });
		const order: string[] = [];
		const first = w.write("a.md", "1", "0").then((r) => order.push(`1:${r}`));
		// Queued behind the first, so it already sees "1" as the current content.
		const second = w.write("a.md", "2", "1").then((r) => order.push(`2:${r}`));
		await Promise.all([first, second]);
		expect(order).toEqual(["1:written", "2:written"]);
		expect(disk.files.get("a.md")).toBe("2");
	});

	it("registers each write as a self-write carrying the written text's hash", async () => {
		const { selfWrites, w } = writer({ "a.md": "old" });
		expect(await w.write("a.md", "new", "old")).toBe("written");
		expect(selfWrites.consume("a.md", "modify", await sha256Hex("other"))).toBe(false);
		expect(selfWrites.consume("a.md", "modify", await sha256Hex("new"))).toBe(true);
		expect(selfWrites.size).toBe(0);
	});

	it("does not write or register when the file changed since it was read", async () => {
		const { disk, selfWrites, w } = writer({ "a.md": "user edit" });
		expect(await w.write("a.md", "doc", "what reconcile saw")).toBe("changed");
		expect(disk.files.get("a.md")).toBe("user edit");
		expect(selfWrites.size).toBe(0);
	});

	it("does not overwrite an edit that lands between its read and its write", async () => {
		const { disk, selfWrites, w } = writer({ "a.md": "base" });
		disk.beforeProcess = () => disk.files.set("a.md", "racing edit");
		expect(await w.write("a.md", "doc", "base")).toBe("changed");
		expect(disk.files.get("a.md")).toBe("racing edit");
		expect(selfWrites.size).toBe(0);
	});

	it("reports unchanged and missing without registering", async () => {
		const { selfWrites, w } = writer({ "a.md": "same" });
		expect(await w.write("a.md", "same", "whatever")).toBe("unchanged");
		expect(await w.write("gone.md", "x", "")).toBe("missing");
		expect(selfWrites.size).toBe(0);
	});

	it("saves local copies under unique names next to the note, unregistered", async () => {
		const { disk, selfWrites, w } = writer({ "Shared/n.md": "doc" });
		const at = new Date(2026, 10, 18, 9, 5);
		const first = await w.saveCopy("Shared/n.md", "mine", "bob/laptop", at);
		const second = await w.saveCopy("Shared/n.md", "mine again", "bob/laptop", at);
		expect(first).toBe("Shared/n (local copy bob-laptop 202611180905).md");
		expect(second).toBe("Shared/n (local copy bob-laptop 202611180905 2).md");
		expect(disk.files.get(first)).toBe("mine");
		expect(disk.files.get(second)).toBe("mine again");
		expect(selfWrites.size).toBe(0);
	});
});
