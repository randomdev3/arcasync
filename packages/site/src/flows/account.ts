import type { Api, ApiFailure } from "../lib/api";
import { passwordProblem } from "../lib/passwords";
import type { Session } from "../lib/session";
import {
	createStore,
	type Flow,
	type Person,
	type Profile,
	person,
	profile,
	type WorkspaceRow,
	workspaceRows,
} from "./store";

type Failure = Pick<ApiFailure, "code" | "message" | "retryAfter">;

/** A workspace whose PINs this user manages (owner, or any for a server admin). */
export interface ManagedWorkspace {
	id: string;
	name: string;
}

export interface PinItem {
	id: string;
	pin: string;
	role: string;
	admin: boolean;
	expiresAt: number;
	usedAt: number | null;
	usedBy: string | null;
	revoked: boolean;
}

export interface PasswordPanel {
	submitting: boolean;
	currentError: string | null;
	nextError: string | null;
	confirmError: string | null;
	error: Failure | null;
	/** The success message after a set or change. */
	done: string | null;
}

export interface PinPanel {
	workspaceId: string;
	loading: boolean;
	/** A create, revoke or unlock is in flight. */
	busy: boolean;
	items: PinItem[];
	locked: boolean;
	lockedUntil: number | null;
	error: Failure | null;
}

export const CURRENT_REQUIRED_COPY = "Enter your current password.";
export const CURRENT_WRONG_COPY = "That's not your current password.";
export const CONFIRM_COPY = "The two passwords differ.";
export const PASSWORD_SET_COPY = "Password set. Sign in on other devices with your name and it.";
export const PASSWORD_CHANGED_COPY = "Password changed. Your other devices were signed out.";

export const SIGNED_OUT_OFFLINE_COPY =
	"Signed out on this browser. The server couldn't be reached, so that session stays valid until it expires (90 days) unless you sign out again later.";

export type AccountState =
	| { kind: "loading" }
	| { kind: "signed-out"; notice: string | null }
	| {
			kind: "ready";
			me: Person;
			profile: Profile;
			deviceName: string;
			workspaces: WorkspaceRow[];
			signingOut: boolean;
			hasPassword: boolean;
			password: PasswordPanel;
			/** Workspaces whose PINs this user manages; the PIN panel shows when non-empty. */
			managed: ManagedWorkspace[];
			pins: PinPanel | null;
	  }
	| { kind: "error"; error: Failure };

export type AccountEvent =
	| { type: "logout" }
	| { type: "retry" }
	| { type: "password"; current: string; next: string; confirm: string }
	| { type: "pins-workspace"; workspaceId: string }
	| { type: "pin-create"; role: string }
	| { type: "pin-revoke"; id: string }
	| { type: "pins-unlock" }
	/** The profile was renamed elsewhere on the page. */
	| { type: "renamed"; name: string };

type Ready = Extract<AccountState, { kind: "ready" }>;

const freshPassword = (): PasswordPanel => ({
	submitting: false,
	currentError: null,
	nextError: null,
	confirmError: null,
	error: null,
	done: null,
});

function managedWorkspaces(list: unknown, isAdmin: boolean): ManagedWorkspace[] {
	if (!Array.isArray(list)) return [];
	return list.flatMap((w) => {
		const ws = w as { id?: unknown; name?: unknown; role?: unknown };
		if (typeof ws.id !== "string" || typeof ws.name !== "string") return [];
		return isAdmin || ws.role === "owner" ? [{ id: ws.id, name: ws.name }] : [];
	});
}

export function pinItems(list: unknown): PinItem[] {
	if (!Array.isArray(list)) return [];
	return list.flatMap((p) => {
		const x = p as Record<string, unknown>;
		if (typeof x.id !== "string" || typeof x.pin !== "string" || typeof x.role !== "string") {
			return [];
		}
		return [
			{
				id: x.id,
				pin: x.pin,
				role: x.role,
				admin: x.admin === true,
				expiresAt: typeof x.expiresAt === "number" ? x.expiresAt : 0,
				usedAt: typeof x.usedAt === "number" ? x.usedAt : null,
				usedBy: typeof x.usedBy === "string" ? x.usedBy : null,
				revoked: x.revoked === true,
			},
		];
	});
}

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
			hasPassword?: unknown;
		}>("GET", "/api/auth/me", { auth: true });
		const me = res.ok ? person(res.data.user) : null;
		if (res.ok && me) {
			const managed = managedWorkspaces(res.data.workspaces, me.isAdmin);
			const first = managed[0];
			store.set({
				kind: "ready",
				me,
				profile: profile(res.data.user),
				deviceName:
					typeof res.data.device?.name === "string" ? res.data.device.name : "this browser",
				workspaces: workspaceRows(res.data.workspaces),
				signingOut: false,
				hasPassword: res.data.hasPassword === true,
				password: freshPassword(),
				managed,
				pins: first
					? {
							workspaceId: first.id,
							loading: true,
							busy: false,
							items: [],
							locked: false,
							lockedUntil: null,
							error: null,
						}
					: null,
			});
			if (first) await loadPins(first.id);
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

	/** Applies `fn` to the current ready state (async answers must not overwrite newer ones). */
	function update(fn: (state: Ready) => Ready | null) {
		const state = store.get();
		if (state.kind !== "ready") return;
		const next = fn(state);
		if (next) store.set(next);
	}

	/** A 401 on an authed call: the API client cleared the token. */
	function signedOutIf(res: { ok: boolean; code?: string }): boolean {
		if (res.ok || res.code !== "unauthorized") return false;
		store.set({ kind: "signed-out", notice: null });
		return true;
	}

	const pinsPath = (workspaceId: string) =>
		`/api/workspaces/${encodeURIComponent(workspaceId)}/pins`;

	async function loadPins(workspaceId: string) {
		const res = await deps.api.call<{ pins?: unknown; locked?: unknown; lockedUntil?: unknown }>(
			"GET",
			pinsPath(workspaceId),
			{ auth: true },
		);
		if (signedOutIf(res)) return;
		update((state) => {
			if (!state.pins || state.pins.workspaceId !== workspaceId) return null;
			if (!res.ok)
				return { ...state, pins: { ...state.pins, loading: false, busy: false, error: res } };
			return {
				...state,
				pins: {
					...state.pins,
					loading: false,
					busy: false,
					items: pinItems(res.data.pins),
					locked: res.data.locked === true,
					lockedUntil: typeof res.data.lockedUntil === "number" ? res.data.lockedUntil : null,
				},
			};
		});
	}

	/** Create, revoke or unlock, then reload the list (or show the error). */
	async function pinAction(method: "POST" | "DELETE", path: string, body?: unknown) {
		const state = store.get();
		if (state.kind !== "ready" || !state.pins || state.pins.busy) return;
		const { workspaceId } = state.pins;
		store.set({ ...state, pins: { ...state.pins, busy: true, error: null } });
		const res = await deps.api.call(method, path, { auth: true, body });
		if (signedOutIf(res)) return;
		if (!res.ok) {
			update((s) =>
				s.pins?.workspaceId === workspaceId
					? { ...s, pins: { ...s.pins, busy: false, error: res } }
					: null,
			);
			return;
		}
		await loadPins(workspaceId);
	}

	async function setPassword(current: string, next: string, confirm: string) {
		const state = store.get();
		if (state.kind !== "ready" || state.password.submitting) return;
		const checked: PasswordPanel = {
			...freshPassword(),
			currentError: state.hasPassword && !current ? CURRENT_REQUIRED_COPY : null,
			nextError: passwordProblem(next),
		};
		checked.confirmError = !checked.nextError && next !== confirm ? CONFIRM_COPY : null;
		if (checked.currentError || checked.nextError || checked.confirmError) {
			store.set({ ...state, password: checked });
			return;
		}
		store.set({ ...state, password: { ...checked, submitting: true } });
		const had = state.hasPassword;
		const res = await deps.api.call("POST", "/api/auth/password", {
			auth: true,
			body: had ? { current, new: next } : { new: next },
		});
		if (signedOutIf(res)) return;
		update((s) => {
			if (res.ok) {
				return {
					...s,
					hasPassword: true,
					password: { ...freshPassword(), done: had ? PASSWORD_CHANGED_COPY : PASSWORD_SET_COPY },
				};
			}
			const panel = { ...freshPassword() };
			if (res.code === "invalid_credentials") panel.currentError = CURRENT_WRONG_COPY;
			else if (res.code === "weak_password")
				panel.nextError = res.message || "Pick another password.";
			else panel.error = res;
			return { ...s, password: panel };
		});
	}

	if (store.get().kind === "loading") void load();

	return {
		getState: store.get,
		subscribe: store.subscribe,
		send(event) {
			const state = store.get();
			switch (event.type) {
				case "logout":
					void logout();
					break;
				case "retry":
					if (state.kind === "error") void load();
					break;
				case "password":
					void setPassword(event.current, event.next, event.confirm);
					break;
				case "pins-workspace":
					if (state.kind !== "ready" || !state.pins) return;
					if (!state.managed.some((w) => w.id === event.workspaceId)) return;
					store.set({
						...state,
						pins: {
							...state.pins,
							workspaceId: event.workspaceId,
							loading: true,
							items: [],
							error: null,
						},
					});
					void loadPins(event.workspaceId);
					break;
				case "pin-create":
					if (state.kind !== "ready" || !state.pins) return;
					void pinAction("POST", pinsPath(state.pins.workspaceId), { role: event.role });
					break;
				case "pin-revoke":
					if (state.kind !== "ready" || !state.pins) return;
					void pinAction(
						"DELETE",
						`${pinsPath(state.pins.workspaceId)}/${encodeURIComponent(event.id)}`,
					);
					break;
				case "pins-unlock":
					if (state.kind !== "ready" || !state.me.isAdmin) return;
					void pinAction("POST", "/api/admin/pins/unlock");
					break;
				case "renamed":
					if (state.kind !== "ready") return;
					store.set({ ...state, me: { ...state.me, name: event.name } });
					break;
			}
		},
	};
}
