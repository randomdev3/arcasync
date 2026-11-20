/**
 * Google and GitHub sign-in, provider side: authorize URLs and the code → profile exchange. The
 * Worker runs these; AccountsDO keeps the state, identities and handoffs (no outbound fetches
 * in the singleton). With debug stats on, `ARCASYNC_OAUTH_TEST_BASE` replaces every provider
 * endpoint with `<base>/<provider>/…` so tests can run a fake provider.
 */
import type { AuthProvider } from "@arcasync/shared";

export interface OAuthEnv {
	ARCASYNC_DEBUG_STATS: string;
	ARCASYNC_OAUTH_TEST_BASE?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
}

/** What the relay keeps from a provider account. */
export interface OAuthProfile {
	subject: string;
	/** Verified address only (Google: `email_verified`; GitHub: the primary verified one). */
	email: string | null;
	name: string;
	avatarUrl: string | null;
}

interface Endpoints {
	authorize: string;
	token: string;
	user: string;
	emails?: string;
}

const ENDPOINTS: Record<AuthProvider, Endpoints> = {
	google: {
		authorize: "https://accounts.google.com/o/oauth2/v2/auth",
		token: "https://oauth2.googleapis.com/token",
		user: "https://openidconnect.googleapis.com/v1/userinfo",
	},
	github: {
		authorize: "https://github.com/login/oauth/authorize",
		token: "https://github.com/login/oauth/access_token",
		user: "https://api.github.com/user",
		emails: "https://api.github.com/user/emails",
	},
};

function endpoints(env: OAuthEnv, provider: AuthProvider): Endpoints {
	const base =
		env.ARCASYNC_DEBUG_STATS === "1" ? env.ARCASYNC_OAUTH_TEST_BASE?.replace(/\/+$/, "") : "";
	if (!base) return ENDPOINTS[provider];
	const at = (path: string) => `${base}/${provider}/${path}`;
	return {
		authorize: at("authorize"),
		token: at("token"),
		user: at("user"),
		...(provider === "github" ? { emails: at("user/emails") } : {}),
	};
}

function credentials(env: OAuthEnv, provider: AuthProvider) {
	const id = provider === "google" ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID;
	const secret = provider === "google" ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET;
	return id?.trim() && secret?.trim() ? { id: id.trim(), secret: secret.trim() } : null;
}

/** Providers with both a client id and a secret configured. */
export function enabledProviders(env: OAuthEnv): AuthProvider[] {
	return (["google", "github"] as const).filter((p) => credentials(env, p) !== null);
}

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** RFC 7636 S256: base64url(SHA-256(verifier)). Also how `verifierHash` is computed. */
export async function s256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

export async function authorizeUrl(
	env: OAuthEnv,
	provider: AuthProvider,
	{
		redirectUri,
		state,
		codeVerifier,
	}: { redirectUri: string; state: string; codeVerifier: string },
): Promise<string | null> {
	const creds = credentials(env, provider);
	if (!creds) return null;
	const url = new URL(endpoints(env, provider).authorize);
	const params: Record<string, string> =
		provider === "google"
			? {
					client_id: creds.id,
					redirect_uri: redirectUri,
					response_type: "code",
					scope: "openid email profile",
					state,
					code_challenge: await s256(codeVerifier),
					code_challenge_method: "S256",
					prompt: "select_account",
				}
			: {
					client_id: creds.id,
					redirect_uri: redirectUri,
					scope: "read:user user:email",
					state,
					allow_signup: "true",
				};
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url.toString();
}

const USER_AGENT = "ArcaSync-Relay";

async function json(res: Response): Promise<Record<string, unknown> | null> {
	if (!res.ok) return null;
	try {
		const body = (await res.json()) as unknown;
		return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Exchanges the callback's `code` and reads the account; null when anything is off. */
export async function fetchProfile(
	env: OAuthEnv,
	provider: AuthProvider,
	{ code, redirectUri, codeVerifier }: { code: string; redirectUri: string; codeVerifier: string },
): Promise<OAuthProfile | null> {
	const creds = credentials(env, provider);
	if (!creds) return null;
	const ep = endpoints(env, provider);
	const form = new URLSearchParams({
		client_id: creds.id,
		client_secret: creds.secret,
		code,
		redirect_uri: redirectUri,
		...(provider === "google"
			? { grant_type: "authorization_code", code_verifier: codeVerifier }
			: {}),
	});
	const token = await json(
		await fetch(ep.token, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
				"User-Agent": USER_AGENT,
			},
			body: form,
		}),
	);
	// GitHub reports token errors as 200 with an `error` field.
	const accessToken = str(token?.access_token);
	if (!accessToken || token?.error) return null;
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		Accept: provider === "github" ? "application/vnd.github+json" : "application/json",
		"User-Agent": USER_AGENT,
	};
	const user = await json(await fetch(ep.user, { headers }));
	if (!user) return null;

	if (provider === "google") {
		const subject = str(user.sub);
		const email = str(user.email);
		// Only verified Google accounts; a profile without a verified address is refused.
		if (!subject || !email || user.email_verified !== true) return null;
		return {
			subject,
			email,
			name: str(user.name) ?? email.split("@")[0] ?? "user",
			avatarUrl: str(user.picture),
		};
	}

	const id = user.id;
	const subject = typeof id === "number" || typeof id === "string" ? String(id) : null;
	const login = str(user.login);
	if (!subject || !login) return null;
	let email: string | null = null;
	if (ep.emails) {
		const res = await fetch(ep.emails, { headers });
		const list = res.ok ? ((await res.json().catch(() => null)) as unknown) : null;
		if (Array.isArray(list)) {
			const primary = list.find(
				(e: { primary?: unknown; verified?: unknown }) =>
					e?.primary === true && e?.verified === true,
			) as { email?: unknown } | undefined;
			email = str(primary?.email);
		}
	}
	return { subject, email, name: str(user.name) ?? login, avatarUrl: str(user.avatar_url) };
}
