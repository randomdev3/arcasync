import type { DeviceInfo } from "@arcasync/shared";
import type { Api } from "../lib/api";
import { describeError } from "../lib/errors";
import { OAUTH_VERIFIER_KEY, oauthErrorCopy } from "../lib/oauth";
import type { KeyValue, Session } from "../lib/session";
import { safeNext } from "./signin";
import { createStore, type Flow, type Person, person } from "./store";

export type CallbackState =
	| { kind: "exchanging" }
	| { kind: "done"; user: Person; created: boolean; next: string }
	/** `retry`: where "Try again" goes (sign-in, keeping `next`, never auto-starting a provider). */
	| { kind: "error"; code: string; message: string; retry: string };

export interface CallbackParams {
	handoff: string | null;
	error: string | null;
	next: string | null;
}

export function callbackParams(search: string): CallbackParams {
	const q = new URLSearchParams(search);
	return { handoff: q.get("handoff"), error: q.get("error"), next: q.get("next") };
}

/** Back to sign-in with the same `next` (no `provider`, so nothing loops). */
export function retryHref(next: string): string {
	return next === "/account" ? "/signin" : `/signin?next=${encodeURIComponent(next)}`;
}

/**
 * `/auth/callback`: the relay sends the browser here after Google or GitHub with a one-time
 * `handoff` (or an `error`). The handoff plus this tab's verifier buys a session.
 */
export function createCallbackFlow(
	deps: { api: Api; session: Session; pending: KeyValue; device: () => DeviceInfo },
	params: CallbackParams,
): Flow<CallbackState, never> {
	const next = safeNext(params.next);
	const fail = (code: string, message?: string): Extract<CallbackState, { kind: "error" }> => ({
		kind: "error",
		code,
		message: oauthErrorCopy(code, message),
		retry: retryHref(next),
	});
	const verifier = deps.pending.getItem(OAUTH_VERIFIER_KEY);
	const handoff = params.handoff ?? "";
	let initial: CallbackState = { kind: "exchanging" };
	if (params.error || !handoff) {
		deps.pending.removeItem(OAUTH_VERIFIER_KEY);
		initial = fail(params.error || "oauth_failed");
	} else if (!verifier) {
		initial = fail("missing_verifier");
	}
	const store = createStore<CallbackState>(initial);

	async function exchange(v: string) {
		const res = await deps.api.call<{ sessionToken?: unknown; user?: unknown; created?: unknown }>(
			"POST",
			"/api/auth/oauth/exchange",
			{ body: { handoff, verifier: v, device: deps.device() } },
		);
		deps.pending.removeItem(OAUTH_VERIFIER_KEY);
		const user = res.ok ? person(res.data.user) : null;
		if (res.ok && typeof res.data.sessionToken === "string" && user) {
			deps.session.set(res.data.sessionToken);
			store.set({ kind: "done", user, created: res.data.created === true, next });
			return;
		}
		if (res.ok) {
			store.set(fail("oauth_failed"));
		} else if (
			res.code === "network" ||
			res.code === "server_error" ||
			res.code === "rate_limited"
		) {
			store.set({ ...fail("oauth_failed"), code: res.code, message: describeError(res).message });
		} else {
			// The relay answers a bad or reused handoff with `oauth_failed` / `state_expired`.
			store.set(fail(res.code, res.message));
		}
	}

	if (initial.kind === "exchanging" && verifier) void exchange(verifier);

	return { getState: store.get, subscribe: store.subscribe, send() {} };
}
