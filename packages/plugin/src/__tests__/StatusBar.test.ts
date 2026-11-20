import { describe, expect, it } from "vitest";
import { StatusBar } from "../ui/StatusBar";

interface FakeEl {
	text: string;
	attrs: Record<string, string>;
	dataset: Record<string, string>;
	children: FakeEl[];
	clicks: (() => void)[];
	addClass(): void;
	removeClass(): void;
	empty(): void;
	setText(t: string): void;
	setAttribute(name: string, value: string): void;
	createSpan(): FakeEl;
	addEventListener(type: string, fn: () => void): void;
}

function fakeEl(): FakeEl {
	const el: FakeEl = {
		text: "",
		attrs: {},
		dataset: {},
		children: [],
		clicks: [],
		addClass() {},
		removeClass() {},
		empty() {},
		setText(t) {
			el.text = t;
		},
		setAttribute(name, value) {
			el.attrs[name] = value;
		},
		createSpan() {
			const child = fakeEl();
			el.children.push(child);
			return child;
		},
		addEventListener(_type, fn) {
			el.clicks.push(fn);
		},
	};
	return el;
}

function bar(onClick?: () => void) {
	const el = fakeEl();
	const statusBar = new StatusBar(el as unknown as HTMLElement, onClick);
	return { statusBar, el, text: () => el.children[1]?.text, label: () => el.attrs["aria-label"] };
}

describe("StatusBar", () => {
	it("shows the workspace and online count while connected; the tooltip names the user", () => {
		const { statusBar, text, label } = bar();
		statusBar.update({ status: "connected", userName: "alice", workspaceName: "Dev", online: 2 });
		expect(text()).toBe("Dev · 2 online");
		expect(label()).toBe("ArcaSync: alice · Dev · 2 online");
		statusBar.update({ online: 1 });
		expect(text()).toBe("Dev");
		statusBar.update({ online: 0, workspaceName: null });
		expect(text()).toBe("Synced");
		expect(label()).toBe("ArcaSync: alice");
	});

	it("counts the other connected workspaces", () => {
		const { statusBar, text, label } = bar();
		statusBar.update({
			status: "connected",
			userName: "alice",
			workspaceName: "Dev",
			extraWorkspaces: 1,
			online: 3,
		});
		expect(text()).toBe("Dev +1 · 3 online");
		expect(label()).toBe("ArcaSync: alice · Dev +1 · 3 online");
	});

	it("shows offline, syncing and error states", () => {
		const { statusBar, text, label } = bar();
		expect(text()).toBe("Offline");
		statusBar.update({ status: "connecting" });
		expect(text()).toBe("Syncing…");
		statusBar.update({ status: "error", message: "boom" });
		expect(text()).toBe("Error");
		expect(label()).toBe("ArcaSync: error — boom");
	});

	it("opens settings on click", () => {
		let opened = 0;
		const { el } = bar(() => opened++);
		for (const click of el.clicks) click();
		expect(opened).toBe(1);
	});
});
