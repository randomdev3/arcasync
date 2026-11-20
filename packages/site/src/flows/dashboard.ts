import type { Api, ApiFailure, ApiResult } from "../lib/api";
import { isProvider, type Provider } from "../lib/serverInfo";
import { type PinItem, pinItems } from "./account";
import { createStore, type Flow, safeAvatar } from "./store";

type Failure = Pick<ApiFailure, "code" | "message" | "retryAfter">;

const unexpected: Failure = { code: "server_error", message: "Unexpected response" };

export const NAME_RULE_COPY = "Names are 1–60 characters.";
export const NAME_TAKEN_COPY = "Someone already uses that name. Try another.";
export const TEAM_NAME_COPY = "Team names are 1–60 characters.";

/** Team routes answer 403 to non-owners; the shared `forbidden` copy means a disabled account. */
function teamFailure(res: Failure): Failure {
	return res.code === "forbidden"
		? { code: "team_forbidden", message: "Only the team's owners can do that." }
		: res;
}

// --- Profile: rename and linked sign-in methods ------------------------------------------------

export interface IdentityRow {
	provider: Provider;
	email: string | null;
	linkedAt: number;
}

export interface ProfileState {
	renaming: boolean;
	nameError: string | null;
	/** The saved name, after a rename. */
	renamed: string | null;
	/** null while loading. */
	identities: IdentityRow[] | null;
	hasPassword: boolean;
	unlinking: Provider | null;
	notice: string | null;
	error: Failure | null;
}

export type ProfileEvent =
	| { type: "rename"; name: string; current: string }
	| { type: "unlink"; provider: Provider }
	| { type: "reload" };

function identityRows(list: unknown): IdentityRow[] {
	if (!Array.isArray(list)) return [];
	return list.flatMap((i) => {
		const x = (i ?? {}) as { provider?: unknown; email?: unknown; linkedAt?: unknown };
		if (!isProvider(x.provider)) return [];
		return [
			{
				provider: x.provider,
				email: typeof x.email === "string" ? x.email : null,
				linkedAt: typeof x.linkedAt === "number" ? x.linkedAt : 0,
			},
		];
	});
}

/** Whether unlinking `provider` leaves another way to sign in. */
export function canUnlink(state: ProfileState, provider: Provider): boolean {
	const others = (state.identities ?? []).filter((i) => i.provider !== provider).length;
	return others > 0 || state.hasPassword;
}

/**
 * The profile card on /account: rename (`PATCH /api/auth/profile`) and the linked Google / GitHub
 * identities (`GET` / `DELETE /api/auth/identities`). Linking leaves for the provider (the page).
 */
export function createProfileFlow(deps: {
	api: Api;
	hasPassword: boolean;
	onRenamed?: (name: string) => void;
}): Flow<ProfileState, ProfileEvent> {
	const store = createStore<ProfileState>({
		renaming: false,
		nameError: null,
		renamed: null,
		identities: null,
		hasPassword: deps.hasPassword,
		unlinking: null,
		notice: null,
		error: null,
	});

	async function load() {
		const res = await deps.api.call<{ identities?: unknown; hasPassword?: unknown }>(
			"GET",
			"/api/auth/identities",
			{ auth: true },
		);
		const state = store.get();
		if (!res.ok) {
			store.set({ ...state, identities: [], unlinking: null, error: res });
			return;
		}
		store.set({
			...state,
			identities: identityRows(res.data.identities),
			hasPassword:
				typeof res.data.hasPassword === "boolean" ? res.data.hasPassword : state.hasPassword,
			unlinking: null,
		});
	}

	async function rename(raw: string, current: string) {
		const state = store.get();
		if (state.renaming) return;
		const name = raw.trim();
		if (name.length < 1 || name.length > 60) {
			store.set({ ...state, nameError: NAME_RULE_COPY, notice: null, error: null });
			return;
		}
		if (name === current) {
			store.set({ ...state, nameError: null, error: null });
			return;
		}
		store.set({ ...state, renaming: true, nameError: null, notice: null, error: null });
		const res = await deps.api.call<{ user?: { name?: unknown } }>("PATCH", "/api/auth/profile", {
			body: { name },
			auth: true,
		});
		const now = store.get();
		if (res.ok) {
			const saved = typeof res.data?.user?.name === "string" ? res.data.user.name : name;
			store.set({ ...now, renaming: false, renamed: saved, notice: `You're ${saved} now.` });
			deps.onRenamed?.(saved);
		} else if (res.code === "name_taken") {
			store.set({ ...now, renaming: false, nameError: NAME_TAKEN_COPY });
		} else if (res.code === "bad_request") {
			store.set({ ...now, renaming: false, nameError: NAME_RULE_COPY });
		} else {
			store.set({ ...now, renaming: false, error: res });
		}
	}

	async function unlink(provider: Provider) {
		const state = store.get();
		if (state.unlinking || !canUnlink(state, provider)) return;
		store.set({ ...state, unlinking: provider, notice: null, error: null });
		const res = await deps.api.call("DELETE", `/api/auth/identities/${provider}`, { auth: true });
		if (!res.ok) {
			store.set({ ...store.get(), unlinking: null, error: res });
			return;
		}
		store.set({ ...store.get(), notice: "Unlinked." });
		await load();
	}

	void load();

	return {
		getState: store.get,
		subscribe: store.subscribe,
		send(event) {
			switch (event.type) {
				case "rename":
					void rename(event.name, event.current);
					break;
				case "unlink":
					void unlink(event.provider);
					break;
				case "reload":
					void load();
					break;
			}
		},
	};
}

// --- Teams --------------------------------------------------------------------------------------

export interface FolderRow {
	id: string;
	name: string;
}

export interface TeamRow {
	id: string;
	name: string;
	role: string;
	memberCount: number;
	folders: FolderRow[];
}

export interface MemberRow {
	id: string;
	name: string;
	email: string | null;
	color: string;
	avatarUrl: string | null;
	role: string;
}

export interface TeamPanel {
	teamId: string;
	loading: boolean;
	/** An action is in flight. */
	busy: boolean;
	members: MemberRow[];
	/** Owners only; null for everyone else. */
	pins: PinItem[] | null;
	pinsLocked: boolean;
	lockedUntil: number | null;
	invite: { url: string; role: string; expiresAt: number } | null;
	error: Failure | null;
}

export type TeamsState =
	| { kind: "loading" }
	| {
			kind: "ready";
			teams: TeamRow[];
			creating: boolean;
			nameError: string | null;
			createError: Failure | null;
			/** The team being managed (one at a time). */
			open: TeamPanel | null;
			notice: string | null;
			error: Failure | null;
	  }
	| { kind: "error"; error: Failure }
	| { kind: "signed-out" };

export type TeamsEvent =
	| { type: "retry" }
	| { type: "create"; name: string }
	| { type: "open"; teamId: string }
	| { type: "close" }
	| { type: "role"; userId: string; role: string }
	| { type: "remove"; userId: string }
	| { type: "invite"; role: string }
	| { type: "pin-create"; role: string }
	| { type: "pin-revoke"; id: string }
	| { type: "leave" }
	| { type: "delete" };

const ROLES = new Set(["owner", "editor", "viewer"]);

export function teamRows(list: unknown): TeamRow[] {
	if (!Array.isArray(list)) return [];
	return list.flatMap((t) => {
		const x = (t ?? {}) as Record<string, unknown>;
		if (typeof x.id !== "string" || typeof x.name !== "string" || typeof x.role !== "string") {
			return [];
		}
		const folders = Array.isArray(x.folders)
			? x.folders.flatMap((f) => {
					const y = (f ?? {}) as { id?: unknown; name?: unknown };
					return typeof y.id === "string" && typeof y.name === "string"
						? [{ id: y.id, name: y.name }]
						: [];
				})
			: [];
		return [
			{
				id: x.id,
				name: x.name,
				role: x.role,
				memberCount: typeof x.memberCount === "number" ? x.memberCount : 0,
				folders,
			},
		];
	});
}

export function memberRows(list: unknown): MemberRow[] {
	if (!Array.isArray(list)) return [];
	return list.flatMap((m) => {
		const x = (m ?? {}) as { user?: Record<string, unknown>; role?: unknown };
		const u = x.user;
		if (!u || typeof u.id !== "string" || typeof u.name !== "string") return [];
		if (typeof x.role !== "string") return [];
		return [
			{
				id: u.id,
				name: u.name,
				email: typeof u.email === "string" && u.email ? u.email : null,
				color: typeof u.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(u.color) ? u.color : "",
				avatarUrl: safeAvatar(u.avatarUrl),
				role: x.role,
			},
		];
	});
}

const teamPath = (id: string) => `/api/teams/${encodeURIComponent(id)}`;

/**
 * The Teams part of /account: the caller's teams, one opened at a time to manage its members,
 * invite link and PINs. `meId` is the signed-in user (leave = remove yourself). `origin` builds
 * a join link when the relay's invite has no usable URL.
 */
export function createTeamsFlow(deps: {
	api: Api;
	meId: string;
	origin: string;
}): Flow<TeamsState, TeamsEvent> {
	const store = createStore<TeamsState>({ kind: "loading" });
	type Ready = Extract<TeamsState, { kind: "ready" }>;

	function update(fn: (state: Ready) => Ready | null) {
		const state = store.get();
		if (state.kind !== "ready") return;
		const next = fn(state);
		if (next) store.set(next);
	}

	function signedOutIf(res: ApiResult<unknown>): boolean {
		if (res.ok || res.code !== "unauthorized") return false;
		store.set({ kind: "signed-out" });
		return true;
	}

	function updatePanel(teamId: string, fn: (panel: TeamPanel) => TeamPanel) {
		update((s) => (s.open?.teamId === teamId ? { ...s, open: fn(s.open) } : null));
	}

	async function loadTeams(): Promise<boolean> {
		const res = await deps.api.call<{ teams?: unknown }>("GET", "/api/teams", { auth: true });
		if (signedOutIf(res)) return false;
		const state = store.get();
		if (!res.ok) {
			if (state.kind === "ready") store.set({ ...state, error: res });
			else store.set({ kind: "error", error: res });
			return false;
		}
		const teams = teamRows(res.data.teams);
		if (state.kind === "ready") {
			const open = state.open && teams.some((t) => t.id === state.open?.teamId) ? state.open : null;
			store.set({ ...state, teams, open, error: null });
		} else {
			store.set({
				kind: "ready",
				teams,
				creating: false,
				nameError: null,
				createError: null,
				open: null,
				notice: null,
				error: null,
			});
		}
		return true;
	}

	async function loadMembers(teamId: string) {
		const res = await deps.api.call<{ members?: unknown }>("GET", `${teamPath(teamId)}/members`, {
			auth: true,
		});
		if (signedOutIf(res)) return;
		updatePanel(teamId, (p) =>
			res.ok ? { ...p, members: memberRows(res.data.members) } : { ...p, error: teamFailure(res) },
		);
	}

	async function loadPins(teamId: string) {
		const res = await deps.api.call<{ pins?: unknown; locked?: unknown; lockedUntil?: unknown }>(
			"GET",
			`${teamPath(teamId)}/pins`,
			{ auth: true },
		);
		if (signedOutIf(res)) return;
		updatePanel(teamId, (p) =>
			res.ok
				? {
						...p,
						pins: pinItems(res.data.pins),
						pinsLocked: res.data.locked === true,
						lockedUntil: typeof res.data.lockedUntil === "number" ? res.data.lockedUntil : null,
					}
				: { ...p, error: teamFailure(res) },
		);
	}

	async function open(teamId: string) {
		const state = store.get();
		if (state.kind !== "ready") return;
		const team = state.teams.find((t) => t.id === teamId);
		if (!team) return;
		store.set({
			...state,
			notice: null,
			open: {
				teamId,
				loading: true,
				busy: false,
				members: [],
				pins: null,
				pinsLocked: false,
				lockedUntil: null,
				invite: null,
				error: null,
			},
		});
		await Promise.all([
			loadMembers(teamId),
			team.role === "owner" ? loadPins(teamId) : Promise.resolve(),
		]);
		updatePanel(teamId, (p) => ({ ...p, loading: false }));
	}

	/** Runs one team action; on success `after` refreshes what it changed. */
	async function act(
		request: (teamId: string) => Promise<ApiResult<unknown>>,
		after: (teamId: string, res: ApiResult<unknown>) => Promise<void> | void,
	) {
		const state = store.get();
		if (state.kind !== "ready" || !state.open || state.open.busy) return;
		const teamId = state.open.teamId;
		store.set({ ...state, notice: null, open: { ...state.open, busy: true, error: null } });
		const res = await request(teamId);
		if (signedOutIf(res)) return;
		if (!res.ok) {
			updatePanel(teamId, (p) => ({ ...p, busy: false, error: teamFailure(res) }));
			return;
		}
		await after(teamId, res);
		updatePanel(teamId, (p) => ({ ...p, busy: false }));
	}

	async function create(raw: string) {
		const state = store.get();
		if (state.kind !== "ready" || state.creating) return;
		const name = raw.trim();
		if (name.length < 1 || name.length > 60) {
			store.set({ ...state, nameError: TEAM_NAME_COPY, createError: null });
			return;
		}
		store.set({ ...state, creating: true, nameError: null, createError: null, notice: null });
		const res = await deps.api.call<{ id?: unknown }>("POST", "/api/teams", {
			body: { name },
			auth: true,
		});
		if (signedOutIf(res)) return;
		if (!res.ok) {
			update((s) => ({ ...s, creating: false, createError: res }));
			return;
		}
		await loadTeams();
		update((s) => ({ ...s, creating: false }));
		if (typeof res.data.id === "string") await open(res.data.id);
		update((s) => ({ ...s, notice: `Created ${name}.` }));
	}

	/** Leave or delete: the team goes away from the list. */
	async function drop(kind: "leave" | "delete") {
		const state = store.get();
		if (state.kind !== "ready" || !state.open) return;
		const team = state.teams.find((t) => t.id === state.open?.teamId);
		const name = team?.name ?? "the team";
		await act(
			(teamId) =>
				deps.api.call(
					"DELETE",
					kind === "leave"
						? `${teamPath(teamId)}/members/${encodeURIComponent(deps.meId)}`
						: teamPath(teamId),
					{ auth: true },
				),
			async () => {
				update((s) => ({
					...s,
					open: null,
					notice: kind === "leave" ? `You left ${name}.` : `Deleted ${name}.`,
				}));
				await loadTeams();
			},
		);
	}

	void loadTeams();

	return {
		getState: store.get,
		subscribe: store.subscribe,
		send(event) {
			const state = store.get();
			switch (event.type) {
				case "retry":
					if (state.kind === "error") {
						store.set({ kind: "loading" });
						void loadTeams();
					}
					break;
				case "create":
					void create(event.name);
					break;
				case "open":
					if (state.kind === "ready" && state.open?.teamId !== event.teamId) {
						void open(event.teamId);
					}
					break;
				case "close":
					if (state.kind === "ready") store.set({ ...state, open: null });
					break;
				case "role":
					if (!ROLES.has(event.role) || event.userId === deps.meId) return;
					void act(
						(teamId) =>
							deps.api.call(
								"PATCH",
								`${teamPath(teamId)}/members/${encodeURIComponent(event.userId)}`,
								{ body: { role: event.role }, auth: true },
							),
						(teamId) => loadMembers(teamId),
					);
					break;
				case "remove":
					if (event.userId === deps.meId) return;
					void act(
						(teamId) =>
							deps.api.call(
								"DELETE",
								`${teamPath(teamId)}/members/${encodeURIComponent(event.userId)}`,
								{ auth: true },
							),
						async (teamId) => {
							await Promise.all([loadMembers(teamId), loadTeams()]);
						},
					);
					break;
				case "invite":
					if (!ROLES.has(event.role)) return;
					void act(
						(teamId) =>
							deps.api.call("POST", `${teamPath(teamId)}/invites`, {
								body: { role: event.role },
								auth: true,
							}),
						(teamId, res) => {
							const data = (res.ok ? res.data : null) as {
								url?: unknown;
								token?: unknown;
								expiresAt?: unknown;
							} | null;
							const url =
								typeof data?.url === "string" && /^https?:\/\//.test(data.url)
									? data.url
									: typeof data?.token === "string"
										? `${deps.origin}/join?invite=${encodeURIComponent(data.token)}`
										: null;
							updatePanel(teamId, (p) =>
								url
									? {
											...p,
											invite: {
												url,
												role: event.role,
												expiresAt: typeof data?.expiresAt === "number" ? data.expiresAt : 0,
											},
										}
									: { ...p, error: unexpected },
							);
						},
					);
					break;
				case "pin-create":
					if (!ROLES.has(event.role)) return;
					void act(
						(teamId) =>
							deps.api.call("POST", `${teamPath(teamId)}/pins`, {
								body: { role: event.role },
								auth: true,
							}),
						(teamId) => loadPins(teamId),
					);
					break;
				case "pin-revoke":
					void act(
						(teamId) =>
							deps.api.call("DELETE", `${teamPath(teamId)}/pins/${encodeURIComponent(event.id)}`, {
								auth: true,
							}),
						(teamId) => loadPins(teamId),
					);
					break;
				case "leave":
					void drop("leave");
					break;
				case "delete":
					void drop("delete");
					break;
			}
		},
	};
}
