import { describe, expect, it } from "vitest";
import { SelfWriteRegistry } from "../workspace/SelfWriteRegistry";

function registry() {
	const clock = { t: 0 };
	return { clock, reg: new SelfWriteRegistry(() => clock.t) };
}

describe("SelfWriteRegistry", () => {
	it("consumes a matching expectation exactly once", () => {
		const { reg } = registry();
		reg.expect("Shared/a.md", { kind: "modify" });
		expect(reg.consume("Shared/a.md", "modify")).toBe(true);
		expect(reg.consume("Shared/a.md", "modify")).toBe(false);
		expect(reg.size).toBe(0);
	});

	it("does not match another path or kind", () => {
		const { reg } = registry();
		reg.expect("Shared/a.md", { kind: "create" });
		expect(reg.consume("Shared/b.md", "create")).toBe(false);
		expect(reg.consume("Shared/a.md", "modify")).toBe(false);
		expect(reg.consume("Shared/a.md", "create")).toBe(true);
	});

	it("matches hashes when both sides give one", () => {
		const { reg } = registry();
		reg.expect("a.md", { kind: "modify", hash: "h1" });
		expect(reg.consume("a.md", "modify", "other")).toBe(false);
		expect(reg.consume("a.md", "modify", "h1")).toBe(true);

		reg.expect("a.md", { kind: "modify", hash: "h2" });
		expect(reg.consume("a.md", "modify")).toBe(true);

		reg.expect("a.md", { kind: "modify" });
		expect(reg.consume("a.md", "modify", "anything")).toBe(true);
	});

	it("keeps one expectation per registered write", () => {
		const { reg } = registry();
		reg.expect("a.md", { kind: "modify", hash: "h1" });
		reg.expect("a.md", { kind: "modify", hash: "h2" });
		expect(reg.consume("a.md", "modify", "h2")).toBe(true);
		expect(reg.consume("a.md", "modify", "h1")).toBe(true);
		expect(reg.consume("a.md", "modify", "h1")).toBe(false);
	});

	it("expires after the ttl (default 60 s)", () => {
		const { clock, reg } = registry();
		reg.expect("a.md", { kind: "delete" });
		reg.expect("b.md", { kind: "rename", ttlMs: 1000 });
		clock.t = 1000;
		expect(reg.consume("b.md", "rename")).toBe(false);
		expect(reg.size).toBe(1);
		clock.t = 59_999;
		expect(reg.consume("a.md", "delete")).toBe(true);

		reg.expect("c.md", { kind: "delete" });
		clock.t += 60_000;
		expect(reg.consume("c.md", "delete")).toBe(false);
		expect(reg.size).toBe(0);
	});

	it("clear() drops everything", () => {
		const { reg } = registry();
		reg.expect("a.md", { kind: "create" });
		reg.clear();
		expect(reg.consume("a.md", "create")).toBe(false);
	});
});
