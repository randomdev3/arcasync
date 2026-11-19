// Node `fetch` helpers for scenarios (`ctx.api`): dev-login, bootstrap, workspace lookup, ws
// tokens and the dev-only debug endpoints, against the current e2e backend.
import { vaultId as harnessVaultId } from "./obsidian.mjs";

/** `env.dev`'s public bootstrap bearer (packages/relay-cf/wrangler.jsonc); not a secret. */
export const DEV_BOOTSTRAP_TOKEN = "arcasync-local-dev-bootstrap-token-not-secret-0";

/** Thrown for a non-2xx response; `status` and the parsed `body` are kept for assertions. */
export class ApiError extends Error {
	constructor(method, path, status, body) {
		super(`${method} ${path} → ${status} ${JSON.stringify(body)}`);
		this.status = status;
		this.body = body;
	}
}

const tokenOf = (session) => (typeof session === "string" ? session : session?.sessionToken);

/** `getBaseUrl()` is read per call, so the helpers follow `ctx.restartServer()`. */
export function createApi(getBaseUrl) {
	/** Raw request: returns the `Response` whatever its status. */
	async function request(path, { method = "GET", token, body } = {}) {
		const headers = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		if (body !== undefined) headers["Content-Type"] = "application/json";
		return fetch(`${getBaseUrl()}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}

	/** JSON request that throws `ApiError` on a non-2xx status. */
	async function json(path, options = {}) {
		const res = await request(path, options);
		const text = await res.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		if (!res.ok) throw new ApiError(options.method ?? "GET", path, res.status, body);
		return body;
	}

	const ws = (id) => `ws=${encodeURIComponent(id)}`;

	return {
		request,
		json,
		/**
		 * Dev-login (`ARCASYNC_DEV_OPEN_LOGIN=1`) → `SessionResponse`. `vaultId` defaults to the
		 * harness vault id of `name`, so it reuses that vault's device row.
		 */
		devLogin(name, { workspace, role, vaultId = harnessVaultId(name) } = {}) {
			return json("/api/auth/dev-login", {
				method: "POST",
				body: {
					name,
					device: { name: `${name}-e2e-api`, platform: "macos", vaultId },
					...(role ? { role } : {}),
					...(workspace ? { workspace } : {}),
				},
			});
		},
		/** One-shot admin bootstrap → `BootstrapResponse` (relay-cf, P2-1). */
		bootstrap({ workspaceName, token = DEV_BOOTSTRAP_TOKEN }) {
			return json("/api/auth/bootstrap", { method: "POST", token, body: { workspaceName } });
		},
		/** The session's `WorkspaceSummary` with this slug, or `undefined`. */
		async workspaceBySlug(session, slug) {
			const { workspaces } = await json("/api/workspaces", { token: tokenOf(session) });
			return workspaces.find((w) => w.slug === slug);
		},
		/** `WsTokenResponse` for workspace `ws`. */
		wsToken(session, workspaceId) {
			return json("/api/auth/ws-token", {
				method: "POST",
				token: tokenOf(session),
				body: { workspaceId },
			});
		},
		/** Relay counters (`ARCASYNC_DEBUG_STATS=1`). */
		stats(workspaceId) {
			return json(`/api/debug/stats?${ws(workspaceId)}`);
		},
		resetStats(workspaceId) {
			return json(`/api/debug/reset?${ws(workspaceId)}`, { method: "POST" });
		},
		/** Dev-only R2 listing `{objects: [{key, size, uploaded}]}` (relay-cf, P2-4). */
		debugChunks(workspaceId) {
			return json(`/api/debug/chunks?${ws(workspaceId)}`);
		},
	};
}
