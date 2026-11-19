/** Invite tokens are base64url (the plugin's `TOKEN`). */
export const INVITE_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

export interface ParsedInvite {
	token: string;
	/** `site`: a join link (server = its origin + prefix); `obsidian`: server = the relay. */
	kind: "token" | "site" | "obsidian";
	server: string | null;
}

/** The token in `?invite=` or `#invite=` of the current page, if it is well formed. */
export function inviteFromLocation(search: string, hash: string): string | null {
	const fromQuery = new URLSearchParams(search).get("invite");
	const fromHash = new URLSearchParams(hash.replace(/^#/, "")).get("invite");
	for (const candidate of [fromQuery, fromHash]) {
		const token = candidate?.trim() ?? "";
		if (INVITE_TOKEN.test(token)) return token;
	}
	return null;
}

/**
 * What someone pastes: `https://<host>[/<prefix>]/join?invite=…` (or `#invite=`),
 * `obsidian://arcasync?…invite=…`, or the bare token. Anything else is null.
 */
export function parseInvite(input: string): ParsedInvite | null {
	const text = input.trim();
	if (INVITE_TOKEN.test(text)) return { token: text, kind: "token", server: null };
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	if (url.protocol === "obsidian:") {
		const action = `${url.host}${url.pathname}`.replace(/^\/+|\/+$/g, "");
		if (action !== "arcasync") return null;
		const token = url.searchParams.get("invite")?.trim() ?? "";
		if (!INVITE_TOKEN.test(token)) return null;
		const server = url.searchParams.get("server");
		return { token, kind: "obsidian", server: server ? server.replace(/\/+$/, "") : null };
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.username || url.password) return null;
	const match = /^(.*)\/join\/?$/.exec(url.pathname);
	if (!match) return null;
	const token = inviteFromLocation(url.search, url.hash);
	return token ? { token, kind: "site", server: `${url.origin}${match[1]}` } : null;
}

/** The plugin's protocol-handler link: it asks to confirm, then prefills the join. */
export function obsidianInviteLink(server: string, token: string): string {
	return `obsidian://arcasync?server=${encodeURIComponent(server)}&invite=${token}`;
}

/** Opens the plugin's "Approve a device sign-in" modal, prefilled. */
export function obsidianApproveLink(code: string): string {
	return `obsidian://arcasync?approve=${code}`;
}
