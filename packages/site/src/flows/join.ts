import type { DeviceInfo, InviteAcceptRequest } from "@arcasync/shared";
import type { Api, ApiFailure } from "../lib/api";
import { RATE_LIMIT_COOLDOWN_MS } from "../lib/errors";
import { INVITE_TOKEN, parseInvite } from "../lib/invite";
import { normalizePin, passwordProblem } from "../lib/passwords";
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

export type JoinFailure = Pick<ApiFailure, "code" | "message" | "retryAfter">;

/** The PIN form: a new account (PIN, name, password twice), or, signed in, just the PIN. */
export interface PinForm {
	kind: "pin";
	/** A session is stored: the PIN adds its workspace to that account (`redeem-pin`). */
	signedIn: boolean;
	submitting: boolean;
	pinError: string | null;
	nameError: string | null;
	passwordError: string | null;
	confirmError: string | null;
	/** Next to the button (network, server, lock). */
	formError: JoinFailure | null;
	/** Until then the button is off (429 `rate_limited`, 423 `pins_locked`). */
	cooldownUntil: number | null;
}

export type JoinState =
	| { kind: "no-invite"; pasteError: string | null }
	| PinForm
	| { kind: "pin-redeemed"; workspaces: WorkspaceRow[] }
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
	| {
			kind: "joined";
			user: Person;
			workspaces: WorkspaceRow[];
			welcomeBack: boolean;
			/** Joined with a PIN: Obsidian signs in with name + password, not a code. */
			withPassword?: boolean;
	  }
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
	| { type: "not-me" }
	/** Show the PIN form instead of the link field, or go back. */
	| { type: "use-pin" }
	| { type: "use-link" }
	| { type: "pin-submit"; pin: string; name: string; password: string; confirm: string };

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
export const PIN_RULE_COPY = "A PIN is 4 digits.";
export const BAD_PIN_COPY = "That PIN is wrong, already used or expired.";
export const CONFIRM_COPY = "The two passwords differ.";

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

	const pinForm = (): PinForm => ({
		kind: "pin",
		signedIn: deps.session.token() !== null,
		submitting: false,
		pinError: null,
		nameError: null,
		passwordError: null,
		confirmError: null,
		formError: null,
		cooldownUntil: null,
	});

	function cooldown(seconds: number) {
		if (cooldownTimer !== null) clock.clearTimeout(cooldownTimer);
		cooldownTimer = clock.setTimeout(() => {
			cooldownTimer = null;
			const now = store.get();
			if (now.kind === "pin" || now.kind === "choose") store.set({ ...now, cooldownUntil: null });
		}, seconds * 1000);
		return clock.now() + seconds * 1000;
	}

	async function submitPin(event: Extract<JoinEvent, { type: "pin-submit" }>) {
		const state = store.get();
		if (state.kind !== "pin" || state.submitting) return;
		if (state.cooldownUntil !== null && clock.now() < state.cooldownUntil) return;
		const pin = normalizePin(event.pin);
		const name = event.name.trim();
		const checked: PinForm = {
			...state,
			pinError: pin ? null : PIN_RULE_COPY,
			nameError: null,
			passwordError: null,
			confirmError: null,
			formError: null,
		};
		if (!state.signedIn) {
			checked.nameError = name.length >= 1 && name.length <= 60 ? null : NAME_RULE_COPY;
			checked.passwordError = passwordProblem(event.password);
			checked.confirmError =
				!checked.passwordError && event.password !== event.confirm ? CONFIRM_COPY : null;
		}
		if (!pin || checked.nameError || checked.passwordError || checked.confirmError) {
			store.set(checked);
			return;
		}
		store.set({ ...checked, submitting: true });
		const res = state.signedIn
			? await deps.api.call<{ workspaces?: unknown }>("POST", "/api/invites/redeem-pin", {
					body: { pin },
					auth: true,
				})
			: await deps.api.call<{ sessionToken?: unknown; user?: unknown; workspaces?: unknown }>(
					"POST",
					"/api/auth/pin/accept",
					{ body: { pin, name, password: event.password, device: deps.device() } },
				);
		if (res.ok && state.signedIn) {
			store.set({ kind: "pin-redeemed", workspaces: workspaceRows(res.data.workspaces) });
			return;
		}
		const data = res.ok
			? (res.data as { sessionToken?: unknown; user?: unknown; workspaces?: unknown })
			: null;
		const user = data ? person(data.user) : null;
		if (data && typeof data.sessionToken === "string" && user) {
			deps.session.set(data.sessionToken);
			store.set({
				kind: "joined",
				user,
				workspaces: workspaceRows(data.workspaces),
				welcomeBack: false,
				withPassword: true,
			});
			return;
		}
		const failure: JoinFailure = res.ok
			? { code: "server_error", message: "Unexpected response" }
			: res;
		const base: PinForm = { ...checked, submitting: false };
		switch (failure.code) {
			case "invalid_pin":
				store.set({ ...base, pinError: BAD_PIN_COPY });
				break;
			case "name_taken":
				store.set({ ...base, nameError: NAME_TAKEN_COPY });
				break;
			case "weak_password":
				store.set({ ...base, passwordError: failure.message || "Pick a longer password." });
				break;
			case "unauthorized":
				// The stored session was dead (the API client cleared it): create an account instead.
				store.set({ ...pinForm(), signedIn: false });
				break;
			case "rate_limited":
			case "pins_locked": {
				const wait = failure.retryAfter ?? RATE_LIMIT_COOLDOWN_MS / 1000;
				store.set({ ...base, formError: failure, cooldownUntil: cooldown(wait) });
				break;
			}
			default:
				store.set({ ...base, formError: failure });
		}
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
				case "use-pin":
					if (store.get().kind === "no-invite") store.set(pinForm());
					break;
				case "use-link":
					if (store.get().kind === "pin") store.set({ kind: "no-invite", pasteError: null });
					break;
				case "pin-submit":
					void submitPin(event);
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
