import type { Api, ApiFailure } from "../lib/api";
import type { Session } from "../lib/session";
import {
	createStore,
	type Flow,
	type Person,
	person,
	type WorkspaceRow,
	workspaceRows,
} from "./store";

type Failure = Pick<ApiFailure, "code" | "message">;

export const SIGNED_OUT_OFFLINE_COPY =
	"Signed out on this browser. The server couldn't be reached, so that session stays valid until it expires (90 days) unless you sign out again later.";

export type AccountState =
	| { kind: "loading" }
	| { kind: "signed-out"; notice: string | null }
	| {
			kind: "ready";
			me: Person;
			deviceName: string;
			workspaces: WorkspaceRow[];
			signingOut: boolean;
	  }
	| { kind: "error"; error: Failure };

export type AccountEvent = { type: "logout" } | { type: "retry" };

export function createAccountFlow(deps: {
	api: Api;
	session: Session;
}): Flow<AccountState, AccountEvent> {
	const store = createStore<AccountState>(
		deps.session.token() ? { kind: "loading" } : { kind: "signed-out", notice: null },
	);

	async function load() {
		store.set({ kind: "loading" });
		const res = await deps.api.call<{
			user?: unknown;
			device?: { name?: unknown };
			workspaces?: unknown;
		}>("GET", "/api/auth/me", { auth: true });
		const me = res.ok ? person(res.data.user) : null;
		if (res.ok && me) {
			store.set({
				kind: "ready",
				me,
				deviceName:
					typeof res.data.device?.name === "string" ? res.data.device.name : "this browser",
				workspaces: workspaceRows(res.data.workspaces),
				signingOut: false,
			});
		} else if (!res.ok && res.code === "unauthorized") {
			store.set({ kind: "signed-out", notice: null });
		} else {
			store.set({
				kind: "error",
				error: res.ok ? { code: "server_error", message: "Unexpected response" } : res,
			});
		}
	}

	/** Revokes the session on the relay, then forgets it here, whatever the relay answered. */
	async function logout() {
		const state = store.get();
		if (state.kind !== "ready" || state.signingOut) return;
		store.set({ ...state, signingOut: true });
		const res = await deps.api.call("POST", "/api/auth/logout", { auth: true });
		deps.session.clear();
		const offline = !res.ok && (res.code === "network" || res.code === "server_error");
		store.set({ kind: "signed-out", notice: offline ? SIGNED_OUT_OFFLINE_COPY : "Signed out." });
	}

	if (store.get().kind === "loading") void load();

	return {
		getState: store.get,
		subscribe: store.subscribe,
		send(event) {
			if (event.type === "logout") void logout();
			else if (event.type === "retry" && store.get().kind === "error") void load();
		},
	};
}
