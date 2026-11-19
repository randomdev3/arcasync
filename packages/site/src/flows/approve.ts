import type { Api, ApiFailure } from "../lib/api";
import { normalizeUserCode } from "../lib/codes";
import { RATE_LIMIT_COOLDOWN_MS } from "../lib/errors";
import type { Session } from "../lib/session";
import { type Clock, createStore, type Flow, type Person, person, systemClock } from "./store";

export const NOT_FOUND_COPY =
	"Unknown or expired code. Codes last 10 minutes. Get a new one in Obsidian.";
export const BAD_CODE_COPY = "Codes look like BCDF-GHJK (letters only).";
export const RATE_LIMITED_COPY = "Too many lookups. Wait a minute.";
export const SESSION_ENDED_COPY = "Your browser session ended.";

type Failure = Pick<ApiFailure, "code" | "message">;

export interface RequestingDevice {
	name: string;
	platform: string;
}

export type ApproveState =
	| { kind: "checking"; code: string | null }
	| { kind: "needs-session"; code: string | null; notice: string | null }
	| {
			kind: "ready";
			me: Person;
			code: string;
			busy: boolean;
			fieldError: string | null;
			error: Failure | null;
			cooldownUntil: number | null;
	  }
	| {
			kind: "confirm";
			me: Person;
			code: string;
			device: RequestingDevice;
			expiresAt: number;
			busy: "approving" | "denying" | null;
			error: Failure | null;
	  }
	| { kind: "approved"; me: Person; device: RequestingDevice }
	| { kind: "denied"; me: Person }
	| { kind: "error"; error: Failure };

export type ApproveEvent =
	| { type: "lookup"; input: string }
	| { type: "approve" }
	| { type: "deny" }
	| { type: "again" }
	| { type: "retry" };

export interface ApproveDeps {
	api: Api;
	session: Session;
	clock?: Clock;
}

/**
 * `/approve`: lets this signed-in browser approve the code an Obsidian is showing. A code from the
 * URL is looked up once automatically; approving always takes an explicit click.
 */
export function createApproveFlow(
	deps: ApproveDeps,
	urlCode: string | null,
): Flow<ApproveState, ApproveEvent> {
	const clock = deps.clock ?? systemClock;
	const initial = urlCode ? normalizeUserCode(urlCode) : null;
	const store = createStore<ApproveState>(
		deps.session.token()
			? { kind: "checking", code: initial }
			: { kind: "needs-session", code: initial, notice: null },
	);
	let cooldownTimer: unknown = null;
	let me: Person | null = null;

	const signedOut = (code: string | null) =>
		store.set({ kind: "needs-session", code, notice: SESSION_ENDED_COPY });

	const ready = (code: string, extra: Partial<Extract<ApproveState, { kind: "ready" }>> = {}) => {
		if (!me) return;
		store.set({
			kind: "ready",
			me,
			code,
			busy: false,
			fieldError: null,
			error: null,
			cooldownUntil: null,
			...extra,
		});
	};

	async function check() {
		const code = initial;
		const res = await deps.api.call<{ user?: unknown }>("GET", "/api/auth/me", { auth: true });
		const who = res.ok ? person(res.data.user) : null;
		if (who) {
			me = who;
			ready(code ?? "");
			if (code) void lookup(code);
		} else if (!res.ok && res.code === "unauthorized") {
			signedOut(code);
		} else {
			store.set({
				kind: "error",
				error: res.ok ? { code: "server_error", message: "Unexpected response" } : res,
			});
		}
	}

	async function lookup(input: string) {
		const state = store.get();
		if (state.kind !== "ready" || state.busy) return;
		if (state.cooldownUntil !== null && clock.now() < state.cooldownUntil) return;
		const code = normalizeUserCode(input);
		if (!code) {
			store.set({ ...state, code: input, fieldError: BAD_CODE_COPY, error: null });
			return;
		}
		store.set({ ...state, code, busy: true, fieldError: null, error: null });
		const res = await deps.api.call<{
			device?: { name?: unknown; platform?: unknown };
			expiresAt?: unknown;
		}>("GET", `/api/auth/device/lookup?userCode=${encodeURIComponent(code)}`, { auth: true });
		if (res.ok && me && typeof res.data.device?.name === "string") {
			store.set({
				kind: "confirm",
				me,
				code,
				device: {
					name: res.data.device.name,
					platform:
						typeof res.data.device.platform === "string" ? res.data.device.platform : "unknown",
				},
				expiresAt:
					typeof res.data.expiresAt === "number" ? res.data.expiresAt : clock.now() + 600_000,
				busy: null,
				error: null,
			});
			return;
		}
		const failure: Failure = res.ok
			? { code: "server_error", message: "Unexpected response" }
			: res;
		if (failure.code === "unauthorized") signedOut(code);
		else if (failure.code === "not_found") ready(code, { fieldError: NOT_FOUND_COPY });
		else if (failure.code === "rate_limited") {
			const until = clock.now() + RATE_LIMIT_COOLDOWN_MS;
			ready(code, {
				error: { code: "rate_limited", message: RATE_LIMITED_COPY },
				cooldownUntil: until,
			});
			if (cooldownTimer !== null) clock.clearTimeout(cooldownTimer);
			cooldownTimer = clock.setTimeout(() => {
				cooldownTimer = null;
				const now = store.get();
				if (now.kind === "ready") store.set({ ...now, cooldownUntil: null });
			}, RATE_LIMIT_COOLDOWN_MS);
		} else ready(code, { error: failure });
	}

	async function decide(approve: boolean) {
		const state = store.get();
		if (state.kind !== "confirm" || state.busy) return;
		store.set({ ...state, busy: approve ? "approving" : "denying", error: null });
		const res = await deps.api.call<{ ok?: unknown }>("POST", "/api/auth/device/approve", {
			body: { userCode: state.code, approve },
			auth: true,
		});
		if (res.ok) {
			store.set(
				approve
					? { kind: "approved", me: state.me, device: state.device }
					: { kind: "denied", me: state.me },
			);
		} else if (res.code === "unauthorized") signedOut(state.code);
		else if (res.code === "not_found") ready(state.code, { fieldError: NOT_FOUND_COPY });
		else store.set({ ...state, busy: null, error: res });
	}

	if (store.get().kind === "checking") void check();

	return {
		getState: store.get,
		subscribe: store.subscribe,
		send(event) {
			switch (event.type) {
				case "lookup":
					void lookup(event.input);
					break;
				case "approve":
					void decide(true);
					break;
				case "deny":
					void decide(false);
					break;
				case "again":
					if (me) ready("");
					break;
				case "retry":
					if (store.get().kind === "error") {
						store.set({ kind: "checking", code: initial });
						void check();
					}
					break;
			}
		},
	};
}
