import { describe, expect, it } from "vitest";
import { back, initialStack, openAt, push, resolve } from "../ui/settings/router";

const team = (teamId: string) => ({ kind: "team", teamId }) as const;

describe("settings router", () => {
	it("starts on the welcome page signed out and on home signed in", () => {
		expect(initialStack(false)).toEqual({ history: [], current: { kind: "welcome" } });
		expect(initialStack(true)).toEqual({ history: [], current: { kind: "home" } });
	});

	it("pushes pages and goes back to the root", () => {
		let stack = push(initialStack(true), team("t1"));
		expect(stack).toEqual({ history: [{ kind: "home" }], current: team("t1") });
		expect(push(stack, team("t1"))).toBe(stack);
		stack = back(stack, true);
		expect(stack).toEqual({ history: [], current: { kind: "home" } });
		expect(back(stack, true)).toEqual({ history: [], current: { kind: "home" } });
	});

	it("clears the stack when a root page is pushed", () => {
		const stack = push(push(initialStack(true), team("t1")), { kind: "home" });
		expect(stack).toEqual({ history: [], current: { kind: "home" } });
	});

	it("opens a page from outside the tab on top of the root", () => {
		expect(openAt(team("t2"), true)).toEqual({ history: [{ kind: "home" }], current: team("t2") });
		expect(openAt({ kind: "join" }, false)).toEqual({
			history: [{ kind: "welcome" }],
			current: { kind: "join" },
		});
	});

	it("leaves the signed-out pages once signed in, and the reverse", () => {
		const join = push(initialStack(false), { kind: "join" });
		expect(resolve(join, { signedIn: true, teamIds: null })).toEqual(initialStack(true));
		const page = openAt(team("t1"), true);
		expect(resolve(page, { signedIn: false, teamIds: null })).toEqual(initialStack(false));
	});

	it("drops the page of a team the account left, but not while teams are unknown", () => {
		const page = openAt(team("t1"), true);
		expect(resolve(page, { signedIn: true, teamIds: null })).toBe(page);
		expect(resolve(page, { signedIn: true, teamIds: new Set(["t1"]) })).toBe(page);
		expect(resolve(page, { signedIn: true, teamIds: new Set(["t2"]) })).toEqual(initialStack(true));
	});
});
