import type { Api, ApiFailure } from "./api";
import type { Provider } from "./serverInfo";
import type { KeyValue } from "./session";

/** Session storage: the secret whose hash binds an OAuth handoff to this tab. */
export const OAUTH_VERIFIER_KEY = "arcasync.oauthVerifier";
/** Session storage: an invite or PIN to redeem once the OAuth session exists (set on /join). */
export const OAUTH_REDEEM_KEY = "arcasync.oauthRedeem";

export interface OAuthCrypto {
	random(bytes: number): Uint8Array;
	sha256(data: Uint8Array): Promise<ArrayBuffer>;
}

export const browserCrypto: OAuthCrypto = {
	random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
	sha256: (data) => crypto.subtle.digest("SHA-256", data as BufferSource),
};

export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes: 43 base64url characters. */
export function newVerifier(c: OAuthCrypto): string {
	return base64url(c.random(32));
}

/** base64url SHA-256 of the verifier: the `verifierHash` the relay keeps (43 characters). */
export async function verifierHash(verifier: string, c: OAuthCrypto): Promise<string> {
	return base64url(new Uint8Array(await c.sha256(new TextEncoder().encode(verifier))));
}

export interface StartDeps {
	api: Api;
	/** Session storage. */
	pending: KeyValue;
	crypto: OAuthCrypto;
}

export type StartResult = { ok: true; url: string } | { ok: false; error: OAuthFailure };

type OAuthFailure = Pick<ApiFailure, "code" | "message" | "retryAfter">;

/**
 * `POST /api/auth/oauth/:provider/start`: keeps a fresh verifier in session storage, sends its
 * hash, and returns the provider URL to navigate to. `link` (signed in) adds the provider to the
 * current account instead of signing in.
 */
export async function startOAuth(
	deps: StartDeps,
	provider: Provider,
	options: { intent: "signin" | "link"; next: string },
): Promise<StartResult> {
	const verifier = newVerifier(deps.crypto);
	deps.pending.setItem(OAUTH_VERIFIER_KEY, verifier);
	const res = await deps.api.call<{ url?: unknown }>("POST", `/api/auth/oauth/${provider}/start`, {
		body: {
			intent: options.intent,
			next: options.next,
			verifierHash: await verifierHash(verifier, deps.crypto),
		},
		auth: options.intent === "link",
	});
	if (!res.ok) return { ok: false, error: res };
	const url = typeof res.data.url === "string" ? res.data.url : "";
	if (!/^https?:\/\//i.test(url)) {
		return { ok: false, error: { code: "server_error", message: "Unexpected response" } };
	}
	return { ok: true, url };
}

/** What /join asks to redeem after an OAuth sign-in: `invite:<token>` or `pin:<digits>`. */
export type PendingRedeem = { kind: "invite"; token: string } | { kind: "pin"; pin: string };

export function saveRedeem(pending: KeyValue, redeem: PendingRedeem): void {
	pending.setItem(
		OAUTH_REDEEM_KEY,
		redeem.kind === "invite" ? `invite:${redeem.token}` : `pin:${redeem.pin}`,
	);
}

/** Reads and forgets the stored redemption; it only counts if it matches what /join was given. */
export function takeRedeem(pending: KeyValue): PendingRedeem | null {
	const raw = pending.getItem(OAUTH_REDEEM_KEY);
	pending.removeItem(OAUTH_REDEEM_KEY);
	if (!raw) return null;
	const at = raw.indexOf(":");
	const kind = raw.slice(0, at);
	const value = at < 0 ? "" : raw.slice(at + 1);
	if (kind === "invite" && value) return { kind: "invite", token: value };
	if (kind === "pin" && value) return { kind: "pin", pin: value };
	return null;
}

/** Copy for the relay's OAuth error codes (`/auth/callback?error=` and the exchange). */
export const OAUTH_ERRORS: Record<string, string> = {
	signup_closed:
		"This server only creates accounts from an invite. Use your invite link or PIN and pick a name, then link Google or GitHub on your account page.",
	identity_in_use:
		"That Google or GitHub account is already linked to another ArcaSync account. Sign in with it instead, or unlink it there first.",
	oauth_denied: "Sign-in was cancelled. Nothing changed.",
	oauth_failed: "Sign-in didn't finish. Try again.",
	state_expired: "That sign-in took too long or was already used. Start again.",
	too_many_users: "This server is full and can't take new accounts right now.",
	limit_reached: "You've hit a limit on this server.",
	missing_verifier:
		"This sign-in started in another browser or tab. Start again here, in the same tab.",
};

export function oauthErrorCopy(code: string, message?: string): string {
	if (code === "limit_reached" && message) return message;
	return OAUTH_ERRORS[code] ?? OAUTH_ERRORS.oauth_failed ?? "";
}
