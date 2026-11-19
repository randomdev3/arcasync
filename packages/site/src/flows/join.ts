import type { DeviceInfo, InviteAcceptRequest } from "@arcasync/shared";
import type { Api, ApiFailure } from "../lib/api";
import { RATE_LIMIT_COOLDOWN_MS } from "../lib/errors";
import { INVITE_TOKEN, parseInvite } from "../lib/invite";
import { type KeyValue, PENDING_INVITE_KEY, type Session } from "../lib/session";
import {
	type Clock,
	createStore,
	type Flow,
	type Person,
	person,
	systemClock,
	type WorkspaceRow,
	workspaceRows,
} from "./store";

/** Errors that end the invite (shown as the page, not next to the form). */
const PAGE_ERRORS = new Set(["not_found", "invite_expired", "invite_used", "forbidden"]);

export type JoinFailure = Pick<ApiFailure, "code" | "message">;

export type JoinState =
	| { kind: "no-invite"; pasteError: string | null }
	| { kind: "checking-session"; token: string }
	| {
			kind: "choose";
			token: string;
			submitting: boolean;
			name: string;
			/** Inline on the name field (`name_taken`, `bad_request`, empty). */
			nameError: string | null;
			/** Next to the button (network, server, rate limit). */
			formError: JoinFailure | null;
			cooldownUntil: number | null;
	  }
	| { kind: "joined"; user: Person; workspaces: WorkspaceRow[]; welcomeBack: boolean }
	| {
			kind: "signed-in";
			token: string;
			me: Person;
			redeeming: boolean;
			redeemed: WorkspaceRow[] | null;
			formError: JoinFailure | null;
	  }
	| { kind: "error"; token: string; error: JoinFailure };

export type JoinEvent =
	/** `site`: this page's origin; `relay`: the API base. A pasted link must be for them. */
	| { type: "paste"; input: string; site: string; relay: string }
	| { type: "submit"; name: string }
	| { type: "redeem" }
	| { type: "not-me" };

export interface JoinDeps {
	api: Api;
	session: Session;
	/** Session storage: holds the pending invite across a reload. */
	pending: KeyValue;
	device: () => DeviceInfo;
	clock?: Clock;
}

export const NAME_TAKEN_COPY = "Someone already uses that name. Try another.";
export const NAME_RULE_COPY = "Names are 1–60 characters.";
export const BAD_LINK_COPY = "That doesn't look like an ArcaSync invite link.";

/**
 * `/join`: create an account from an invite, or add its workspace to the signed-in account.
 * `initialToken` is the token from the URL (already stripped from the address bar by the page),
 * or null to fall back to the one kept in session storage.
 */
export function createJoinFlow(
	deps: JoinDeps,
	initialToken: string | null,
): Flow<JoinState, JoinEvent> {
	const clock = deps.clock ?? systemClock;
	const stored = deps.pending.getItem(PENDING_INVITE_KEY);
	const token = initialToken ?? (stored && INVITE_TOKEN.test(stored) ? stored : null);
	const store = createStore<JoinState>(
		token ? { kind: "checking-session", token } : { kind: "no-invite", pasteError: null },
	);
	let cooldownTimer: unknown = null;

	const choose = (t: string): JoinState => ({
		kind: "choose",
		token: t,
		submitting: false,
		name: "",
		nameError: null,
		formError: null,
		cooldownUntil: null,
	});

	async function begin(t: string) {
		deps.pending.setItem(PENDING_INVITE_KEY, t);
		if (!deps.session.token()) {
			store.set(choose(t));
			return;
		}
		store.set({ kind: "checking-session", token: t });
		const me = await deps.api.call<{ user: unknown }>("GET", "/api/auth/me", { auth: true });
		const who = me.ok ? person(me.data.user) : null;
		if (who) {
			store.set({
				kind: "signed-in",
				token: t,
				me: who,
				redeeming: false,
				redeemed: null,
				formError: null,
			});
		} else if (!me.ok && me.code === "forbidden") {
			store.set({ kind: "error", token: t, error: me });
		} else {
			// 401 (the API client already cleared the token) or an unreadable answer: join fresh.
			if (!me.ok && me.code !== "unauthorized") deps.session.clear();
			store.set(choose(t));
		}
	}

	async function submit(rawName: string) {
		const state = store.get();
		if (state.kind !== "choose" || state.submitting) return;
		if (state.cooldownUntil !== null && clock.now() < state.cooldownUntil) return;
		const name = rawName.trim();
		if (name.length < 1 || name.length > 60) {
			store.set({ ...state, name: rawName, nameError: NAME_RULE_COPY, formError: null });
			return;
		}
		store.set({ ...state, name, submitting: true, nameError: null, formError: null });
		const body: InviteAcceptRequest = { token: state.token, name, device: deps.device() };
		const res = await deps.api.call<{
			sessionToken?: unknown;
			user?: unknown;
			workspaces?: unknown;
		}>("POST", "/api/auth/invite/accept", { body });
		const user = res.ok ? person(res.data.user) : null;
		if (res.ok && typeof res.data.sessionToken === "string" && user) {
			deps.session.set(res.data.sessionToken);
			deps.pending.removeItem(PENDING_INVITE_KEY);
			store.set({
				kind: "joined",
				user,
				workspaces: workspaceRows(res.data.workspaces),
				// A re-entry invite signs in as an existing user and ignores the typed name.
				welcomeBack: user.name !== name,
			});
			return;
		}
		const failure: JoinFailure = res.ok
			? { code: "server_error", message: "Unexpected response" }
			: res;
		const base = { ...state, name, submitting: false };
		if (PAGE_ERRORS.has(failure.code)) {
			store.set({ kind: "error", token: state.token, error: failure });
		} else if (failure.code === "name_taken") {
			store.set({ ...base, nameError: NAME_TAKEN_COPY });
		} else if (failure.code === "bad_request") {
			store.set({ ...base, nameError: NAME_RULE_COPY });
		} else if (failure.code === "rate_limited") {
			const until = clock.now() + RATE_LIMIT_COOLDOWN_MS;
			store.set({ ...base, formError: failure, cooldownUntil: until });
			if (cooldownTimer !== null) clock.clearTimeout(cooldownTimer);
			cooldownTimer = clock.setTimeout(() => {
				cooldownTimer = null;
				const now = store.get();
				if (now.kind === "choose") store.set({ ...now, cooldownUntil: null });
			}, RATE_LIMIT_COOLDOWN_MS);
		} else {
			store.set({ ...base, formError: failure });
		}
	}

	async function redeem() {
		const state = store.get();
		if (state.kind !== "signed-in" || state.redeeming || state.redeemed) return;
		store.set({ ...state, redeeming: true, formError: null });
		const res = await deps.api.call<{ workspaces?: unknown }>("POST", "/api/invites/redeem", {
			body: { token: state.token },
			auth: true,
		});
		if (res.ok) {
			deps.pending.removeItem(PENDING_INVITE_KEY);
			store.set({ ...state, redeeming: false, redeemed: workspaceRows(res.data.workspaces) });
		} else if (res.code === "unauthorized") {
			store.set(choose(state.token));
		} else if (PAGE_ERRORS.has(res.code)) {
			store.set({ kind: "error", token: state.token, error: res });
		} else {
			store.set({ ...state, redeeming: false, formError: res });
		}
	}

	function paste(input: string, site: string, relay: string) {
		const parsed = parseInvite(input);
		if (!parsed) {
			store.set({ kind: "no-invite", pasteError: BAD_LINK_COPY });
			return;
		}
		const expected = parsed.kind === "obsidian" ? relay : site;
		if (parsed.server && parsed.server !== expected.replace(/\/+$/, "")) {
			store.set({
				kind: "no-invite",
				pasteError: `That invite is for another server (${parsed.server}). Open the link you were sent instead.`,
			});
			return;
		}
		void begin(parsed.token);
	}

	if (token) void begin(token);

	return {
		getState: store.get,
		subscribe: store.subscribe,
		send(event) {
			switch (event.type) {
				case "paste":
					paste(event.input, event.site, event.relay);
					break;
				case "submit":
					void submit(event.name);
					break;
				case "redeem":
					void redeem();
					break;
				case "not-me": {
					const state = store.get();
					if (state.kind !== "signed-in") return;
					deps.session.clear();
					store.set(choose(state.token));
					break;
				}
			}
		},
	};
}
