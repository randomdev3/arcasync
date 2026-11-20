import type { Session } from "./session";

export interface ApiFailure {
	ok: false;
	status: number;
	/** The relay's `error.code`, or `network`, `rate_limited`, `server_error`, `http_<status>`. */
	code: string;
	message: string;
	/** Seconds to wait (429 `rate_limited`, 423 `pins_locked`): `details.retryAfter` or `Retry-After`. */
	retryAfter?: number;
}

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

export interface CallOptions {
	body?: unknown;
	/** Send the stored session as a bearer; a 401 then signs this browser out. */
	auth?: boolean;
}

export interface Api {
	call<T>(method: Method, path: string, options?: CallOptions): Promise<ApiResult<T>>;
}

export interface ApiDeps {
	/** The relay's base URL (another origin: the site is on Cloudflare Pages). */
	base: string;
	fetch: typeof fetch;
	session: Session;
	/** A 401 on an authenticated call: the stored token was cleared. */
	onSignedOut?: () => void;
	/** 503 `misconfigured`: the relay has no usable secret. */
	onMisconfigured?: () => void;
}

/** Event names the pages listen for (dispatched on `window`). */
export const SIGNED_OUT_EVENT = "arcasync:signed-out";
export const MISCONFIGURED_EVENT = "arcasync:misconfigured";

/** A failure whose body was not the relay's JSON (a proxy page, Cloudflare's own 429). */
function statusFailure(status: number): ApiFailure {
	if (status === 429)
		return { ok: false, status, code: "rate_limited", message: "Too many requests" };
	if (status >= 500) return { ok: false, status, code: "server_error", message: "Server error" };
	return { ok: false, status, code: `http_${status}`, message: `HTTP ${status}` };
}

function errorFrom(body: unknown): { code: string; message: string; retryAfter?: number } | null {
	const error = (
		body as {
			error?: { code?: unknown; message?: unknown; details?: { retryAfter?: unknown } };
		} | null
	)?.error;
	if (!error || typeof error.code !== "string") return null;
	const retryAfter = error.details?.retryAfter;
	return {
		code: error.code,
		message: typeof error.message === "string" ? error.message : "",
		...(typeof retryAfter === "number" && retryAfter > 0 ? { retryAfter } : {}),
	};
}

/** `Retry-After` in seconds (the relay sends whole seconds), or undefined. */
function retryAfterHeader(res: Response): number | undefined {
	const value = Number(res.headers.get("retry-after"));
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * JSON client for the relay's `/api/*` (cross-origin, bearer auth, no cookies). Never throws: every outcome is an `ApiResult`. Response
 * bodies are not validated beyond what each caller reads (no zod in the browser).
 */
export function createApi(deps: ApiDeps): Api {
	return {
		async call<T>(method: Method, path: string, options: CallOptions = {}) {
			const headers: Record<string, string> = { Accept: "application/json" };
			if (options.body !== undefined) headers["Content-Type"] = "application/json";
			const token = options.auth ? deps.session.token() : null;
			if (token) headers.Authorization = `Bearer ${token}`;
			let res: Response;
			try {
				res = await deps.fetch(`${deps.base}${path}`, {
					method,
					headers,
					body: options.body === undefined ? undefined : JSON.stringify(options.body),
					credentials: "omit",
					cache: "no-store",
				});
			} catch {
				return {
					ok: false,
					status: 0,
					code: "network",
					message: "Network error",
				} satisfies ApiFailure;
			}
			let body: unknown = null;
			let json = false;
			try {
				const text = await res.text();
				body = text ? JSON.parse(text) : null;
				json = true;
			} catch {}
			if (res.ok && json) return { ok: true, data: body as T };
			if (res.ok) return statusFailure(502);
			const error = json ? errorFrom(body) : null;
			const failure: ApiFailure = error
				? { ok: false, status: res.status, ...error }
				: statusFailure(res.status);
			if (failure.retryAfter === undefined) {
				const wait = retryAfterHeader(res);
				if (wait !== undefined) failure.retryAfter = wait;
			}
			if (failure.code === "misconfigured") deps.onMisconfigured?.();
			if (res.status === 401 && options.auth) {
				deps.session.clear();
				deps.onSignedOut?.();
			}
			return failure;
		},
	};
}
