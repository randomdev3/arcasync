import { describe, expect, it } from "vitest";
import {
	containingRoot,
	foldersOverlap,
	isSyncedNote,
	isUnder,
	toVault,
	toWs,
} from "../workspace/paths";

describe("paths", () => {
	it("foldersOverlap: the same folder or one inside the other", () => {
		expect(foldersOverlap("a", "a")).toBe(true);
		expect(foldersOverlap("a", "a/b")).toBe(true);
		expect(foldersOverlap("a/b", "a")).toBe(true);
		expect(foldersOverlap("a", "ab")).toBe(false);
		expect(foldersOverlap("ab", "a")).toBe(false);
		expect(foldersOverlap("a/b", "a/c")).toBe(false);
	});

	it("containingRoot picks the item whose root contains the path (sessionFor)", () => {
		const shared = { root: "Shared", name: "primary" };
		const second = { root: "Second", name: "second" };
		const unmapped = { root: null, name: "unmapped" };
		const sessions = [unmapped, shared, second];
		expect(containingRoot(sessions, "Shared/a.md")).toBe(shared);
		expect(containingRoot(sessions, "Second/x/y.md")).toBe(second);
		expect(containingRoot(sessions, "SecondX/y.md")).toBeNull();
		expect(containingRoot(sessions, "Second")).toBeNull();
		expect(containingRoot(sessions, "elsewhere.md")).toBeNull();
	});

	it("isUnder matches only strict descendants of the root folder", () => {
		expect(isUnder("Shared", "Shared/a.md")).toBe(true);
		expect(isUnder("Shared", "Shared/x/y/a.md")).toBe(true);
		expect(isUnder("Shared", "Shared")).toBe(false);
		expect(isUnder("Shared", "Shared/")).toBe(false);
		expect(isUnder("Shared", "SharedX/a.md")).toBe(false);
		expect(isUnder("Shared", "Other/Shared/a.md")).toBe(false);
		expect(isUnder("", "a.md")).toBe(false);
		expect(isUnder("Team/Shared", "Team/Shared/a.md")).toBe(true);
	});

	it("round-trips vault and workspace paths", () => {
		expect(toWs("Shared", "Shared/notes/a.md")).toBe("notes/a.md");
		expect(toVault("Shared", "notes/a.md")).toBe("Shared/notes/a.md");
		expect(toVault("Team/Shared", toWs("Team/Shared", "Team/Shared/a.md") ?? "")).toBe(
			"Team/Shared/a.md",
		);
	});

	it("rejects paths outside the root", () => {
		expect(toWs("Shared", "Elsewhere/a.md")).toBeNull();
		expect(toWs("Shared", "Shared")).toBeNull();
	});

	it("rejects traversal and empty segments", () => {
		for (const bad of ["../a.md", "x/../../a.md", "./a.md", "x//a.md", "/a.md", "x/", ""]) {
			expect(toVault("Shared", bad), bad).toBeNull();
		}
		expect(toWs("Shared", "Shared/x/../a.md")).toBeNull();
	});

	it("rejects .obsidian, .trash and other hidden segments", () => {
		for (const bad of [".obsidian/app.json", "x/.obsidian/a.md", ".trash/a.md", "x/.trash/a.md"]) {
			expect(toVault("Shared", bad), bad).toBeNull();
			expect(toWs("Shared", `Shared/${bad}`), bad).toBeNull();
		}
		expect(toWs("Shared", "Shared/.hidden/a.md")).toBeNull();
		expect(toWs("Shared", "Shared/.a.md")).toBeNull();
	});

	it("isSyncedNote accepts markdown but not Excalidraw or other kinds", () => {
		expect(isSyncedNote("a.md")).toBe(true);
		expect(isSyncedNote("x/A.MD")).toBe(true);
		expect(isSyncedNote("a.excalidraw.md")).toBe(false);
		expect(isSyncedNote("a.canvas")).toBe(false);
		expect(isSyncedNote("a.png")).toBe(false);
	});
});
