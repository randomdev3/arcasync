import type { Api, ApiResult, CallOptions, Method } from "../lib/api";
import { createSession, memoryStorage } from "../lib/session";

export interface Call {
	method: string;
	path: string;
	options: CallOptions;
}

type Reply = ApiResult<unknown> | Promise<ApiResult<unknown>>;

/** An `Api` answering from per-route queues (`"POST /api/x"`); records every call. */
export function fakeApi(routes: Record<string, Reply[] | ((call: Call) => Reply)> = {}) {
	const calls: Call[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const api: Api = {
		async call<T>(method: Method, path: string, options: CallOptions = {}) {
			const call = { method, path, options };
			calls.push(call);
			const key = `${method} ${path.split("?")[0]}`;
			const route = routes[key];
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				if (!route) throw new Error(`unexpected call ${key}`);
				const reply = typeof route === "function" ? route(call) : route.shift();
				if (!reply) throw new Error(`no reply left for ${key}`);
				return (await reply) as ApiResult<T>;
			} finally {
				inFlight -= 1;
			}
		},
	};
	return { api, calls, maxInFlight: () => maxInFlight };
}

export const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
export const fail = (
	status: number,
	code: string,
	message = code,
	retryAfter?: number,
): ApiResult<never> => ({
	ok: false,
	status,
	code,
	message,
	...(retryAfter === undefined ? {} : { retryAfter }),
});

export function sessionWith(token: string | null = null) {
	const storage = memoryStorage();
	const session = createSession(storage);
	if (token) session.set(token);
	return { storage, session };
}

export const USER = { id: "u1", name: "mara", color: "#2fae8f", isAdmin: false };
export const WORKSPACES = [{ id: "w1", slug: "team", name: "Team", role: "editor" }];
export const DEVICE = { name: "Browser · Firefox", platform: "macos" as const, vaultId: "web-1" };

/** Lets pending promise callbacks run. */
export const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};
