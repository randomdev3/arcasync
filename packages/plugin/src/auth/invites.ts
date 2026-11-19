/** An invite to join: the relay it is for (null for a bare token) and its secret token. */
export interface InviteLink {
	server: string | null;
	token: string;
}

/** Invite tokens are base64url (`newOpaqueToken`: 32 random bytes → 43 characters). */
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

/** `http(s)://host[:port][/path]` without trailing slashes, or null for anything else. */
export function normalizeServerUrl(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.username || url.password || url.search || url.hash) return null;
	return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** Both name the same relay (scheme, host, port and path; case and trailing slashes ignored). */
export function sameServer(a: string, b: string): boolean {
	const x = normalizeServerUrl(a);
	return x !== null && x === normalizeServerUrl(b);
}

/** The `server` and `invite` parameters of an `obsidian://arcasync` link, validated. */
export function inviteFromParams(params: {
	server?: string | null;
	invite?: string | null;
}): InviteLink | null {
	const token = params.invite?.trim() ?? "";
	if (!TOKEN.test(token)) return null;
	if (!params.server) return { server: null, token };
	const server = normalizeServerUrl(params.server);
	return server ? { server, token } : null;
}

/**
 * Parses what a user pastes as an invite: the website's `https://<site>[/<prefix>]/join?invite=…`
 * link (the token may also sit in the fragment, `#invite=…`), the
 * `obsidian://arcasync?server=…&invite=…` link, or the bare token. The website is hosted apart
 * from the relay, so a join link names no relay (unless it carries `server=`): like a bare token,
 * it is for the configured Server URL. A non-http(s) server, or any other https path, is rejected.
 */
export function parseInviteLink(input: string): InviteLink | null {
	const text = input.trim();
	if (TOKEN.test(text)) return { server: null, token: text };
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	if (url.protocol === "http:" || url.protocol === "https:") return joinPageInvite(url);
	if (url.protocol !== "obsidian:") return null;
	const action = `${url.host}${url.pathname}`.replace(/^\/+|\/+$/g, "");
	if (action !== "arcasync") return null;
	return inviteFromParams({
		server: url.searchParams.get("server"),
		invite: url.searchParams.get("invite"),
	});
}

/** The website's `…/join?invite=<token>` (or `#invite=<token>`), optionally with `server=`. */
function joinPageInvite(url: URL): InviteLink | null {
	if (url.username || url.password) return null;
	if (!/\/join\/?$/.test(url.pathname)) return null;
	const hash = new URLSearchParams(url.hash.slice(1));
	return inviteFromParams({
		server: url.searchParams.get("server") ?? hash.get("server"),
		invite: url.searchParams.get("invite") ?? hash.get("invite"),
	});
}

/** A 4-digit invite PIN (spaces and dashes ignored), or null. */
export function parsePin(input: string): string | null {
	const digits = input.replace(/[\s-]/g, "");
	return /^[0-9]{4}$/.test(digits) ? digits : null;
}
