import type { DeviceInfo } from "@arcasync/shared";
import type { Api, ApiFailure } from "../lib/api";
import { DEVICE_CODE_INTERVAL_S } from "../lib/codes";
import type { Session } from "../lib/session";
import { type Clock, createStore, type Flow, type Person, person, systemClock } from "./store";

/** Where `/signin?next=` may send the browser afterwards: a few same-origin pages, nothing else. */
const NEXT = /^\/(approve|account|join)(\?[^#]*)?$/;
export const DEFAULT_NEXT = "/account";

export function safeNext(raw: string | null | undefined): string {
	return raw && NEXT.test(raw) && !raw.includes("\\") ? raw : DEFAULT_NEXT;
}

export type SigninState =
	| { kind: "idle"; error: Pick<ApiFailure, "code" | "message"> | null }
	| { kind: "starting" }
	| { kind: "waiting"; userCode: string; expiresAt: number }
	| { kind: "approved"; user: Person; next: string }
	| { kind: "denied" }
	| { kind: "expired" };

export type SigninEvent = { type: "start" } | { type: "cancel" } | { type: "visible" };

export interface SigninDeps {
	api: Api;
	session: Session;
	device: () => DeviceInfo;
	next: string;
	clock?: Clock;
}

const STEP_MS = 5_000;

/**
 * `/signin`: a device code for this browser, approved in a signed-in Obsidian. A port of the
 * plugin's `DeviceLogin`: one request in flight, the next poll only after the last answer, the
 * interval grows 5 s on every `slow_down`, and polling stops at the deadline or on cancel. It
 * keeps polling while the tab is hidden (the user is in Obsidian); on return it polls at once if
 * the last poll is more than an interval old.
 */
export function createSigninFlow(deps: SigninDeps): Flow<SigninState, SigninEvent> {
	const clock = deps.clock ?? systemClock;
	const store = createStore<SigninState>({ kind: "idle", error: null });
	/** Bumped on cancel or restart: answers from an older run are ignored. */
	let run = 0;
	let timer: unknown = null;
	let inFlight = false;
	let intervalMs = DEVICE_CODE_INTERVAL_S * 1000;
	let deadline = 0;
	let lastPollAt = 0;
	let deviceCode = "";

	const stopTimer = () => {
		if (timer !== null) clock.clearTimeout(timer);
		timer = null;
	};

	function schedule(id: number, ms: number) {
		stopTimer();
		const wait = Math.max(0, Math.min(ms, deadline - clock.now()));
		timer = clock.setTimeout(() => {
			timer = null;
			void poll(id);
		}, wait);
	}

	async function poll(id: number) {
		if (id !== run || inFlight) return;
		if (clock.now() >= deadline) {
			run += 1;
			store.set({ kind: "expired" });
			return;
		}
		inFlight = true;
		lastPollAt = clock.now();
		const res = await deps.api.call<{ sessionToken?: unknown; user?: unknown }>(
			"POST",
			"/api/auth/device/poll",
			{ body: { deviceCode } },
		);
		inFlight = false;
		if (id !== run) return;
		const user = res.ok ? person(res.data.user) : null;
		if (res.ok && typeof res.data.sessionToken === "string" && user) {
			run += 1;
			deps.session.set(res.data.sessionToken);
			store.set({ kind: "approved", user, next: deps.next });
			return;
		}
		const code = res.ok ? "server_error" : res.code;
		if (code === "access_denied") {
			run += 1;
			store.set({ kind: "denied" });
		} else if (code === "expired_token") {
			run += 1;
			store.set({ kind: "expired" });
		} else {
			// Pending, or a transient failure (network, 5xx, 429): try again after the interval.
			if (code === "slow_down" || code === "rate_limited") intervalMs += STEP_MS;
			schedule(id, intervalMs);
		}
	}

	async function start() {
		const state = store.get();
		if (state.kind === "starting" || state.kind === "waiting") return;
		run += 1;
		const id = run;
		stopTimer();
		store.set({ kind: "starting" });
		const res = await deps.api.call<{
			deviceCode?: unknown;
			userCode?: unknown;
			interval?: unknown;
			expiresIn?: unknown;
		}>("POST", "/api/auth/device/start", { body: { device: deps.device() } });
		if (id !== run) return;
		if (
			!res.ok ||
			typeof res.data.deviceCode !== "string" ||
			typeof res.data.userCode !== "string"
		) {
			store.set({
				kind: "idle",
				error: res.ok ? { code: "server_error", message: "Unexpected response" } : res,
			});
			return;
		}
		const interval = typeof res.data.interval === "number" ? res.data.interval : 0;
		const expiresIn = typeof res.data.expiresIn === "number" ? res.data.expiresIn : 600;
		intervalMs = Math.max(interval, DEVICE_CODE_INTERVAL_S) * 1000;
		deadline = clock.now() + expiresIn * 1000;
		deviceCode = res.data.deviceCode;
		lastPollAt = clock.now();
		store.set({ kind: "waiting", userCode: res.data.userCode, expiresAt: deadline });
		schedule(id, intervalMs);
	}

	return {
		getState: store.get,
		subscribe: store.subscribe,
		send(event) {
			const state = store.get();
			switch (event.type) {
				case "start":
					void start();
					break;
				case "cancel":
					if (state.kind !== "waiting" && state.kind !== "starting") return;
					run += 1;
					stopTimer();
					store.set({ kind: "idle", error: null });
					break;
				case "visible":
					if (state.kind !== "waiting" || inFlight) return;
					if (clock.now() - lastPollAt >= intervalMs) {
						stopTimer();
						void poll(run);
					}
					break;
			}
		},
	};
}
