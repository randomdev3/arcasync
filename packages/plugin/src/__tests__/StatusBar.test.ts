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
		expect(el.text).toBe("TeamSync: alice · Dev · 2 online");
		bar.update({ online: 0, workspaceName: null });
		expect(el.text).toBe("TeamSync: alice");
	});

	it("shows offline, connecting and error states", () => {
		const el = fakeEl();
		const bar = new StatusBar(el as unknown as HTMLElement);
		expect(el.text).toBe("TeamSync: offline");
		bar.update({ status: "connecting" });
		expect(el.text).toBe("TeamSync: connecting…");
		bar.update({ status: "error", message: "boom" });
		expect(el.text).toBe("TeamSync: error — boom");
	});
});
