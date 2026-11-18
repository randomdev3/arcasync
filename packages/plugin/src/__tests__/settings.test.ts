import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../settings";

describe("normalizeSettings", () => {
	it("defaults the P1 fields", () => {
		const s = normalizeSettings(null);
		expect(s.sharedFolder).toBeNull();
		expect(s.devLoginRole).toBe("");
		expect(s).toEqual(DEFAULT_SETTINGS);
	});

	it("keeps a valid shared folder and trims its slashes", () => {
		expect(
			normalizeSettings({ sharedFolder: { path: "/Team/Notes/", workspaceId: "ws1" } }),
		).toMatchObject({ sharedFolder: { path: "Team/Notes", workspaceId: "ws1" } });
		expect(normalizeSettings({ sharedFolder: { path: "Shared" } })).toMatchObject({
			sharedFolder: { path: "Shared", workspaceId: "" },
		});
	});

	it("drops a malformed shared folder", () => {
		for (const sharedFolder of ["Shared", { path: "" }, { path: "/" }, { workspaceId: "ws1" }, 3]) {
			expect(normalizeSettings({ sharedFolder }).sharedFolder).toBeNull();
		}
	});

	it("accepts only known dev-login roles", () => {
		expect(normalizeSettings({ devLoginRole: "viewer" }).devLoginRole).toBe("viewer");
		expect(normalizeSettings({ devLoginRole: "admin" }).devLoginRole).toBe("");
	});
});
