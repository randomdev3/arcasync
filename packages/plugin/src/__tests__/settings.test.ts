import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../settings";

describe("normalizeSettings", () => {
	it("defaults the P1 fields", () => {
		const s = normalizeSettings(null);
		expect(s.sharedFolders).toEqual([]);
		expect(s.devLoginRole).toBe("");
		expect(s).toEqual(DEFAULT_SETTINGS);
	});

	it("migrates a legacy single shared folder into a one-element list, trimming its slashes", () => {
		expect(
			normalizeSettings({ sharedFolder: { path: "/Team/Notes/", workspaceId: "ws1" } }),
		).toMatchObject({ sharedFolders: [{ path: "Team/Notes", workspaceId: "ws1" }] });
		expect(normalizeSettings({ sharedFolder: { path: "Shared" } })).toMatchObject({
			sharedFolders: [{ path: "Shared", workspaceId: "" }],
		});
		expect(normalizeSettings({ sharedFolder: null }).sharedFolders).toEqual([]);
		// The list wins over a stray legacy field.
		expect(
			normalizeSettings({
				sharedFolder: { path: "Old", workspaceId: "ws1" },
				sharedFolders: [{ path: "New", workspaceId: "ws2" }],
			}).sharedFolders,
		).toEqual([{ path: "New", workspaceId: "ws2" }]);
	});

	it("drops a malformed shared folder", () => {
		for (const sharedFolder of ["Shared", { path: "" }, { path: "/" }, { workspaceId: "ws1" }, 3]) {
			expect(normalizeSettings({ sharedFolder }).sharedFolders).toEqual([]);
			expect(normalizeSettings({ sharedFolders: [sharedFolder] }).sharedFolders).toEqual([]);
		}
	});

	it("drops folders that overlap an earlier one or repeat a workspace", () => {
		expect(
			normalizeSettings({
				sharedFolders: [
					{ path: "Shared", workspaceId: "ws1" },
					{ path: "Shared/inner", workspaceId: "ws2" },
					{ path: "Shared", workspaceId: "ws3" },
					{ path: "Second", workspaceId: "ws1" },
					{ path: "SharedToo", workspaceId: "ws2" },
					{ path: "Unbound", workspaceId: "" },
					{ path: "Unbound2", workspaceId: "" },
				],
			}).sharedFolders,
		).toEqual([
			{ path: "Shared", workspaceId: "ws1" },
			{ path: "SharedToo", workspaceId: "ws2" },
			{ path: "Unbound", workspaceId: "" },
		]);
	});

	it("accepts only known dev-login roles", () => {
		expect(normalizeSettings({ devLoginRole: "viewer" }).devLoginRole).toBe("viewer");
		expect(normalizeSettings({ devLoginRole: "admin" }).devLoginRole).toBe("");
	});
});
