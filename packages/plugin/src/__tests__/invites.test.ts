import { describe, expect, it } from "vitest";
import { inviteFromParams, parseInviteLink, sameServer } from "../auth/invites";

const TOKEN = "Qm9vdHN0cmFwLWludml0ZS10b2tlbi0wMTIzNDU2Nzg5YWI";

describe("parseInviteLink", () => {
	it("parses the relay's obsidian://arcasync link", () => {
		const server = encodeURIComponent("https://relay.example.com/");
		expect(parseInviteLink(`obsidian://arcasync?server=${server}&invite=${TOKEN}`)).toEqual({
			server: "https://relay.example.com",
			token: TOKEN,
		});
		expect(
			parseInviteLink(
				`  obsidian://arcasync/?server=${encodeURIComponent("http://localhost:8787")}&invite=${TOKEN}\n`,
			),
		).toEqual({ server: "http://localhost:8787", token: TOKEN });
	});

	it("parses the website's https join link (query or fragment, optional path prefix)", () => {
		const cases: [string, string][] = [
			[`https://relay.example.com/join?invite=${TOKEN}`, "https://relay.example.com"],
			[`https://relay.example.com/join/?invite=${TOKEN}`, "https://relay.example.com"],
			[`https://relay.example.com/join#invite=${TOKEN}`, "https://relay.example.com"],
			[`http://localhost:8789/join?invite=${TOKEN}`, "http://localhost:8789"],
			[` https://Example.com/team/join?invite=${TOKEN}\n`, "https://example.com/team"],
		];
		for (const [link, server] of cases) {
			expect(parseInviteLink(link), link).toEqual({ server, token: TOKEN });
		}
	});

	it("rejects other https paths, missing tokens and credentials in a join link", () => {
		for (const link of [
			`https://relay.example.com/joinx?invite=${TOKEN}`,
			`https://relay.example.com/join/more?invite=${TOKEN}`,
			`https://relay.example.com/approve?invite=${TOKEN}`,
			"https://relay.example.com/join",
			"https://relay.example.com/join?invite=short",
			`https://user:pw@relay.example.com/join?invite=${TOKEN}`,
			`ftp://relay.example.com/join?invite=${TOKEN}`,
		]) {
			expect(parseInviteLink(link), link).toBeNull();
		}
	});

	it("parses a bare token as an invite for the current server", () => {
		expect(parseInviteLink(` ${TOKEN} `)).toEqual({ server: null, token: TOKEN });
	});

	it("rejects a non-http server", () => {
		for (const server of ["javascript:alert(1)", "file:///etc/passwd", "ftp://x", "relay"]) {
			const link = `obsidian://arcasync?server=${encodeURIComponent(server)}&invite=${TOKEN}`;
			expect(parseInviteLink(link)).toBeNull();
		}
		const withCreds = encodeURIComponent("https://user:pw@relay.example.com");
		expect(parseInviteLink(`obsidian://arcasync?server=${withCreds}&invite=${TOKEN}`)).toBeNull();
	});

	it("rejects other links, approve links and malformed tokens", () => {
		expect(parseInviteLink(`obsidian://open?vault=x&invite=${TOKEN}`)).toBeNull();
		expect(parseInviteLink(`https://relay.example.com/?invite=${TOKEN}`)).toBeNull();
		expect(parseInviteLink("obsidian://arcasync?approve=BCDF-GHJK")).toBeNull();
		expect(parseInviteLink("obsidian://arcasync?invite=short")).toBeNull();
		expect(parseInviteLink("not a token at all")).toBeNull();
		expect(parseInviteLink("")).toBeNull();
	});

	it("validates protocol handler params the same way", () => {
		expect(inviteFromParams({ server: "http://localhost:8787/", invite: TOKEN })).toEqual({
			server: "http://localhost:8787",
			token: TOKEN,
		});
		expect(inviteFromParams({ server: "obsidian://x", invite: TOKEN })).toBeNull();
		expect(inviteFromParams({ invite: TOKEN })).toEqual({ server: null, token: TOKEN });
	});
});

describe("sameServer", () => {
	it("ignores case of the host and trailing slashes", () => {
		expect(sameServer("http://LOCALHOST:8787/", "http://localhost:8787")).toBe(true);
		expect(sameServer("https://relay.example.com/team", "https://relay.example.com/team/")).toBe(
			true,
		);
	});

	it("tells different schemes, ports and paths apart", () => {
		expect(sameServer("http://localhost:8787", "http://localhost:8788")).toBe(false);
		expect(sameServer("http://relay.example.com", "https://relay.example.com")).toBe(false);
		expect(sameServer("https://a.example.com/x", "https://a.example.com/y")).toBe(false);
		expect(sameServer("nonsense", "nonsense")).toBe(false);
	});
});
