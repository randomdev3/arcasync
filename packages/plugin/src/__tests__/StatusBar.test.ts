import { describe, expect, it } from "vitest";
import { StatusBar } from "../ui/StatusBar";

function fakeEl() {
	const el = {
		text: "",
		dataset: {} as Record<string, string>,
		addClass() {},
		removeClass() {},
		setText(t: string) {
			el.text = t;
		},
		setAttribute() {},
	};
	return el;
}

describe("StatusBar", () => {
	it("shows user, workspace and online count while connected", () => {
		const el = fakeEl();
		const bar = new StatusBar(el as unknown as HTMLElement);
		bar.update({ status: "connected", userName: "alice", workspaceName: "Dev", online: 2 });
		expect(el.text).toBe("ArcaSync: alice · Dev · 2 online");
		bar.update({ online: 0, workspaceName: null });
		expect(el.text).toBe("ArcaSync: alice");
	});

	it("names the primary workspace and counts the others while several are connected", () => {
		const el = fakeEl();
		const bar = new StatusBar(el as unknown as HTMLElement);
		bar.update({
			status: "connected",
			userName: "alice",
			workspaceName: "Dev",
			extraWorkspaces: 1,
			online: 3,
		});
		expect(el.text).toBe("ArcaSync: alice · Dev +1 · 3 online");
		bar.update({ extraWorkspaces: 2, online: 1 });
		expect(el.text).toBe("ArcaSync: alice · Dev +2 · 1 online");
		bar.update({ extraWorkspaces: 0 });
		expect(el.text).toBe("ArcaSync: alice · Dev · 1 online");
	});

	it("shows offline, connecting and error states", () => {
		const el = fakeEl();
		const bar = new StatusBar(el as unknown as HTMLElement);
		expect(el.text).toBe("ArcaSync: offline");
		bar.update({ status: "connecting" });
		expect(el.text).toBe("ArcaSync: connecting…");
		bar.update({ status: "error", message: "boom" });
		expect(el.text).toBe("ArcaSync: error — boom");
	});
});
