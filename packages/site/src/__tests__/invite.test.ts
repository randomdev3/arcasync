import { describe, expect, it } from "vitest";
import { inviteFromLocation, obsidianInviteLink, parseInvite } from "../lib/invite";

const TOKEN = "Qm9vdHN0cmFwLWludml0ZS10b2tlbi0wMTIzNDU2Nzg5YWI";

describe("inviteFromLocation", () => {
	it("reads ?invite= or #invite=", () => {
		expect(inviteFromLocation(`?invite=${TOKEN}`, "")).toBe(TOKEN);
		expect(inviteFromLocation("", `#invite=${TOKEN}`)).toBe(TOKEN);
		expect(inviteFromLocation("?invite=short", `#invite=${TOKEN}`)).toBe(TOKEN);
	});

	it("ignores missing and malformed tokens", () => {
		expect(inviteFromLocation("", "")).toBeNull();
		expect(inviteFromLocation("?invite=short", "")).toBeNull();
		expect(inviteFromLocation("?invite=<script>aaaaaaaaaaaaaaaa", "")).toBeNull();
	});
});

describe("parseInvite", () => {
	it("accepts a site join link, an obsidian link and a bare token", () => {
		expect(parseInvite(`https://arca.example.com/join?invite=${TOKEN}`)).toEqual({
			token: TOKEN,
			kind: "site",
			server: "https://arca.example.com",
		});
		expect(parseInvite(`https://arca.example.com/x/join/#invite=${TOKEN}`)).toMatchObject({
			kind: "site",
			server: "https://arca.example.com/x",
		});
		const relay = encodeURIComponent("https://relay.example.com/");
		expect(parseInvite(`obsidian://arcasync?server=${relay}&invite=${TOKEN}`)).toEqual({
			token: TOKEN,
			kind: "obsidian",
			server: "https://relay.example.com",
		});
		expect(parseInvite(`  ${TOKEN}\n`)).toEqual({ token: TOKEN, kind: "token", server: null });
	});

	it("rejects junk, other paths, short tokens and credentials", () => {
		for (const input of [
			"",
			"hello there",
			`https://arca.example.com/joinx?invite=${TOKEN}`,
			`https://arca.example.com/?invite=${TOKEN}`,
			"https://arca.example.com/join?invite=short",
			`https://u:p@arca.example.com/join?invite=${TOKEN}`,
			`obsidian://open?invite=${TOKEN}`,
			`javascript:alert(1)//join?invite=${TOKEN}`,
		]) {
			expect(parseInvite(input), input).toBeNull();
		}
	});

	it("builds the plugin's deep link", () => {
		expect(obsidianInviteLink("https://relay.example.com", TOKEN)).toBe(
			`obsidian://arcasync?server=https%3A%2F%2Frelay.example.com&invite=${TOKEN}`,
		);
	});
});
