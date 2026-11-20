import "../styles/main.css";
import "../styles/flow.css";
import {
	type AccountState,
	createAccountFlow,
	type PasswordPanel,
	type PinItem,
} from "../flows/account";
import {
	canUnlink,
	createProfileFlow,
	createTeamsFlow,
	type MemberRow,
	type ProfileState,
	type TeamPanel,
	type TeamRow,
	type TeamsState,
} from "../flows/dashboard";
import { initChrome, refreshNav } from "../lib/chrome";
import {
	$,
	announce,
	focus,
	paintDot,
	renderError,
	setBusy,
	showState,
	wireCopyButtons,
} from "../lib/dom";
import { describeError, formatWait } from "../lib/errors";
import { beginOAuth } from "../lib/providers";
import {
	loadServerInfo,
	PROVIDER_LABELS,
	type Provider,
	type SiteServerInfo,
} from "../lib/serverInfo";

const app = initChrome();
const root = $("[data-flow]");
const flow = createAccountFlow({ api: app.api, session: app.session });
let lastKind = "";

const passwordInputs = {
	current: $<HTMLInputElement>("#password-current"),
	next: $<HTMLInputElement>("#password-new"),
	confirm: $<HTMLInputElement>("#password-confirm"),
};
const workspaceSelect = $<HTMLSelectElement>("#pins-workspace");
const roleSelect = $<HTMLSelectElement>("#pin-role");
let lastPanel: PasswordPanel | null = null;

/** "Sun 23 Nov, 18:00" in the browser's locale. */
const when = (ms: number) =>
	new Date(ms).toLocaleString(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});

function pinStatus(pin: PinItem, now: number): string {
	if (pin.usedAt !== null) return `used by ${pin.usedBy ?? "someone"}`;
	if (pin.revoked) return "revoked";
	if (pin.expiresAt <= now) return "expired";
	return `until ${when(pin.expiresAt)}`;
}

/** PIN table rows with a Revoke button on the live ones. */
function pinRows(items: PinItem[], busy: boolean, onRevoke: (id: string) => void) {
	const now = Date.now();
	return items.map((pin) => {
		const row = document.createElement("tr");
		const code = document.createElement("code");
		code.textContent = pin.pin;
		const cells = [code, `${pin.role}${pin.admin ? " · admin" : ""}`, pinStatus(pin, now)];
		for (const content of cells) {
			const cell = document.createElement("td");
			cell.append(content);
			row.append(cell);
		}
		const actions = document.createElement("td");
		if (pin.usedAt === null && !pin.revoked && pin.expiresAt > now) {
			const revoke = document.createElement("button");
			revoke.type = "button";
			revoke.className = "btn btn--small btn--danger";
			revoke.textContent = "Revoke";
			revoke.disabled = busy;
			revoke.dataset.key = `revoke-${pin.id}`;
			revoke.setAttribute("aria-label", `Revoke PIN ${pin.pin}`);
			revoke.addEventListener("click", () => onRevoke(pin.id));
			actions.append(revoke);
		}
		row.append(actions);
		return row;
	});
}

function renderPassword(state: Extract<AccountState, { kind: "ready" }>) {
	const panel = state.password;
	$("[data-password-title]").textContent = state.hasPassword ? "Change password" : "Set a password";
	$("[data-password-desc]").textContent = state.hasPassword
		? "Changing it signs your other devices out."
		: "Then you can sign in with your name and password, here and in Obsidian.";
	$<HTMLInputElement>("[data-password-username]").value = state.me.name;
	$("[data-password-current]").hidden = !state.hasPassword;
	const submit = $<HTMLButtonElement>("[data-password-submit]");
	submit.dataset.label = state.hasPassword ? "Change password" : "Set password";
	setBusy(submit, panel.submitting, "Saving…");
	const fields = [
		[passwordInputs.current, $("#password-current-error"), panel.currentError],
		[passwordInputs.next, $("#password-new-error"), panel.nextError],
		[passwordInputs.confirm, $("#password-confirm-error"), panel.confirmError],
	] as const;
	let first: { input: HTMLInputElement; message: string } | null = null;
	for (const [input, error, message] of fields) {
		error.hidden = !message;
		error.textContent = message ?? "";
		input.setAttribute("aria-invalid", String(Boolean(message)));
		if (message && !first) first = { input, message };
	}
	const done = $("[data-password-done]");
	done.hidden = !panel.done;
	done.textContent = panel.done ?? "";
	renderError($("[data-password-error]"), panel.error ? describeError(panel.error) : null);
	// React once per change of the panel (pin loads re-render with the same panel object).
	if (panel !== lastPanel && !panel.submitting) {
		if (panel.done) {
			for (const input of Object.values(passwordInputs)) input.value = "";
			announce(panel.done);
		} else if (first) {
			focus(first.input);
			announce(first.message);
		} else if (panel.error) {
			announce(describeError(panel.error).message);
		}
	}
	lastPanel = panel;
}

function renderPins(state: Extract<AccountState, { kind: "ready" }>) {
	const panel = state.pins;
	$("[data-pins]").hidden = panel === null;
	if (!panel) return;
	const multiple = state.managed.length > 1;
	$("[data-pins-workspace-field]").hidden = !multiple;
	if (multiple && workspaceSelect.options.length !== state.managed.length) {
		workspaceSelect.replaceChildren(...state.managed.map((w) => new Option(w.name, w.id)));
	}
	workspaceSelect.value = panel.workspaceId;
	setBusy($<HTMLButtonElement>("[data-pin-create]"), panel.busy, "Working…");

	const locked = $("[data-pins-locked]");
	locked.hidden = !panel.locked;
	if (panel.locked) {
		const left = panel.lockedUntil
			? formatWait((panel.lockedUntil - Date.now()) / 1000)
			: "a while";
		locked.textContent = `PIN entry is locked for ${left} after too many wrong PINs.${
			state.me.isAdmin ? "" : " A server admin can unlock it."
		}`;
	}
	$("[data-pins-unlock-row]").hidden = !(panel.locked && state.me.isAdmin);
	renderError($("[data-pins-error]"), panel.error ? describeError(panel.error) : null);
	$("[data-pins-loading]").hidden = !panel.loading;

	const rows = pinRows(panel.items, panel.busy, (id) => flow.send({ type: "pin-revoke", id }));
	$("[data-pins-list]").replaceChildren(...rows);
	$("[data-pins-table]").hidden = panel.loading || rows.length === 0;
	$("[data-no-pins]").hidden = panel.loading || rows.length > 0;
}

// --- People & devices (server admins) ---

interface PersonRow {
	id: string;
	name: string;
	isAdmin: boolean;
	disabled: boolean;
	hasPassword: boolean;
	joined: { via: string; pin: string | null; at: number } | null;
	lastSignInAt: number | null;
	workspaces: { id: string; name: string; role: string }[];
	devices: { id: string; name: string; platform: string; signedIn: boolean }[];
	reset: { pin: string; expiresAt: number } | null;
}

const people = (() => {
	const card = $("[data-people]");
	const list = $("[data-people-list]");
	const loading = $("[data-people-loading]");
	const notice = $("[data-people-notice]");
	const errorEl = $("[data-people-error]");
	let shown = false;
	let busy = false;
	let meName = "";

	const say = (text: string | null) => {
		notice.hidden = !text;
		notice.textContent = text ?? "";
		if (text) announce(text);
	};

	function button(label: string, danger: boolean, onClick: () => void, aria?: string) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = `btn btn--small${danger ? " btn--danger" : ""}`;
		b.textContent = label;
		if (aria) b.setAttribute("aria-label", aria);
		b.disabled = busy;
		b.addEventListener("click", onClick);
		return b;
	}

	function text(tag: string, className: string, content: string) {
		const el = document.createElement(tag);
		el.className = className;
		el.textContent = content;
		return el;
	}

	function joinedText(p: PersonRow): string {
		if (!p.joined) return "joined: unknown";
		const how = p.joined.via === "pin" ? `PIN ${p.joined.pin ?? "?"}` : "invite link";
		return `joined with ${how} · ${when(p.joined.at)}`;
	}

	function row(p: PersonRow): HTMLLIElement {
		const li = document.createElement("li");
		const head = document.createElement("div");
		head.className = "people__head";
		head.append(text("span", "people__name", p.name));
		if (p.name === meName) head.append(text("span", "badge", "you"));
		if (p.isAdmin) head.append(text("span", "badge", "admin"));
		if (p.disabled) head.append(text("span", "badge", "disabled"));
		if (!p.hasPassword) head.append(text("span", "badge", "no password"));
		li.append(head);

		const meta = [
			joinedText(p),
			`last sign-in: ${p.lastSignInAt ? when(p.lastSignInAt) : "never"}`,
			`workspaces: ${p.workspaces.map((w) => `${w.name} (${w.role})`).join(", ") || "none"}`,
		];
		for (const line of meta) li.append(text("p", "people__meta", line));
		if (p.reset) {
			li.append(
				text(
					"p",
					"people__meta",
					`reset PIN ${p.reset.pin} · until ${when(p.reset.expiresAt)} · not used yet`,
				),
			);
		}

		const devices = document.createElement("ul");
		devices.className = "people__devices";
		if (p.devices.length === 0) devices.append(text("li", "muted", "No devices."));
		for (const d of p.devices) {
			const item = document.createElement("li");
			item.append(
				text("span", "", `${d.name} · ${d.platform} — ${d.signedIn ? "signed in" : "signed out"}`),
			);
			if (d.signedIn) {
				item.append(
					button(
						"Sign out",
						true,
						() => {
							if (!confirm(`Sign ${p.name} out on ${d.name}?`)) return;
							void act(
								"POST",
								`/api/admin/devices/${encodeURIComponent(d.id)}/sign-out`,
								`${p.name} is signed out on ${d.name}.`,
							);
						},
						`Sign ${p.name} out on ${d.name}`,
					),
				);
			}
			devices.append(item);
		}
		li.append(devices);

		const actions = document.createElement("div");
		actions.className = "people__actions";
		actions.append(
			button(
				p.reset ? "New reset PIN" : "Reset password PIN",
				false,
				() => void resetPin(p),
				`Make a password reset PIN for ${p.name}`,
			),
		);
		if (p.name !== meName) {
			actions.append(
				p.disabled
					? button("Enable", false, () => void enable(p), `Enable ${p.name}`)
					: button(
							"Disable",
							true,
							() => {
								if (!confirm(`Disable ${p.name}? This signs them out everywhere.`)) return;
								void act(
									"POST",
									`/api/admin/users/${encodeURIComponent(p.id)}/disable`,
									`${p.name} is disabled.`,
								);
							},
							`Disable ${p.name}`,
						),
			);
		}
		li.append(actions);
		return li;
	}

	async function load() {
		loading.hidden = false;
		const res = await app.api.call<{ people?: PersonRow[] }>("GET", "/api/admin/people", {
			auth: true,
		});
		loading.hidden = true;
		busy = false;
		if (!res.ok) {
			renderError(errorEl, describeError(res));
			return;
		}
		renderError(errorEl, null);
		const rows = Array.isArray(res.data.people) ? res.data.people : [];
		list.replaceChildren(...rows.map(row));
	}

	async function act(method: "POST", path: string, done: string) {
		if (busy) return;
		busy = true;
		say(null);
		const res = await app.api.call(method, path, { auth: true });
		if (!res.ok) {
			busy = false;
			renderError(errorEl, describeError(res));
			return;
		}
		say(done);
		await load();
	}

	async function resetPin(p: PersonRow) {
		if (busy) return;
		busy = true;
		say(null);
		const res = await app.api.call<{ pin?: string; expiresAt?: number }>(
			"POST",
			`/api/admin/users/${encodeURIComponent(p.id)}/reset-pin`,
			{ auth: true },
		);
		if (!res.ok) {
			busy = false;
			renderError(errorEl, describeError(res));
			return;
		}
		say(
			`Reset PIN for ${p.name}: ${res.data.pin} (24 hours, works once). They enter it at /signin → Forgot password, with their name and a new password.`,
		);
		await load();
	}

	async function enable(p: PersonRow) {
		if (busy) return;
		busy = true;
		say(null);
		const res = await app.api.call<{ url?: string }>(
			"POST",
			`/api/admin/users/${encodeURIComponent(p.id)}/enable`,
			{ auth: true },
		);
		if (!res.ok) {
			busy = false;
			renderError(errorEl, describeError(res));
			return;
		}
		say(`${p.name} is enabled. Send them this one-time sign-in link: ${res.data.url ?? ""}`);
		await load();
	}

	$("[data-people-refresh]").addEventListener("click", () => {
		if (!busy) void load();
	});

	return {
		show(isAdmin: boolean, name: string) {
			card.hidden = !isAdmin;
			meName = name;
			if (isAdmin && !shown) {
				shown = true;
				void load();
			}
		},
	};
})();

function render(state: AccountState) {
	const changed = state.kind !== lastKind;
	lastKind = state.kind;
	const section = showState(root, state.kind);
	switch (state.kind) {
		case "ready": {
			$("[data-me-name]").textContent = state.me.name;
			paintDot($("[data-me-dot]"), state.me.color);
			$("[data-admin]").hidden = !state.me.isAdmin;
			$("[data-device-name]").textContent = state.deviceName;
			const body = $("[data-workspaces]");
			body.replaceChildren(
				...state.workspaces.map((w) => {
					const row = document.createElement("tr");
					for (const text of [w.name, w.role]) {
						const cell = document.createElement("td");
						cell.textContent = text;
						row.append(cell);
					}
					return row;
				}),
			);
			const empty = state.workspaces.length === 0;
			$("[data-workspaces-table]").hidden = empty;
			$("[data-no-workspaces]").hidden = !empty;
			const teamsOn = info?.teams === true;
			$("[data-legacy-workspaces]").hidden = teamsOn;
			$("[data-owner-note]").hidden =
				teamsOn || !(state.me.isAdmin || state.workspaces.some((w) => w.role === "owner"));
			const avatar = $<HTMLImageElement>("[data-me-avatar]");
			avatar.hidden = !state.profile.avatarUrl;
			if (state.profile.avatarUrl && avatar.src !== state.profile.avatarUrl) {
				avatar.src = state.profile.avatarUrl;
			}
			$("[data-me-dot]").hidden = Boolean(state.profile.avatarUrl);
			const email = $("[data-me-email]");
			email.hidden = !state.profile.email;
			email.textContent = state.profile.email ? `${state.profile.email} · ` : "";
			setBusy($<HTMLButtonElement>("[data-logout]"), state.signingOut, "Signing out…");
			renderPassword(state);
			renderPins(state);
			// Teams have their own PINs; admins keep this card only to unlock PIN entry.
			if (teamsOn && !(state.me.isAdmin && state.pins?.locked)) $("[data-pins]").hidden = true;
			people.show(state.me.isAdmin, state.me.name);
			startDashboard(state);
			break;
		}
		case "signed-out": {
			const notice = $("[data-signed-out-notice]");
			notice.hidden = !state.notice;
			notice.textContent = state.notice ?? "";
			refreshNav(app);
			if (changed && lastKind !== "" && state.notice) {
				announce(state.notice);
				focus(section?.querySelector("h1") ?? null);
			}
			break;
		}
		case "error":
			renderError($("[data-page-error]"), describeError(state.error));
			break;
		case "loading":
			break;
	}
}

// --- Profile and teams (servers with OAuth and teams) ------------------------------------------

let info: SiteServerInfo | null = null;
let profileFlow: ReturnType<typeof createProfileFlow> | null = null;
let teamsFlow: ReturnType<typeof createTeamsFlow> | null = null;
let hadPassword: boolean | null = null;
const renameInput = $<HTMLInputElement>("#rename");
const renameError = $("#rename-error");
const renameSubmit = $<HTMLButtonElement>("[data-rename-submit]");

function startDashboard(state: Extract<AccountState, { kind: "ready" }>) {
	if (!info) return;
	if (info.auth && !profileFlow) {
		$("[data-profile]").hidden = false;
		renameInput.value = state.me.name;
		profileFlow = createProfileFlow({
			api: app.api,
			hasPassword: state.hasPassword,
			onRenamed: (name) => {
				flow.send({ type: "renamed", name });
				renameInput.value = name;
			},
		});
		profileFlow.subscribe(renderProfile);
		renderProfile(profileFlow.getState());
	} else if (profileFlow && hadPassword === false && state.hasPassword) {
		// A password was just set: it counts as a sign-in method for Unlink.
		profileFlow.send({ type: "reload" });
	}
	hadPassword = state.hasPassword;
	if (info.teams && !teamsFlow && state.profile.id) {
		$("[data-teams]").hidden = false;
		teamsFlow = createTeamsFlow({ api: app.api, meId: state.profile.id, origin: location.origin });
		teamsFlow.subscribe(renderTeams);
		renderTeams(teamsFlow.getState());
	}
}

let lastProfile: ProfileState | null = null;

function renderProfile(state: ProfileState) {
	setBusy(renameSubmit, state.renaming, "Saving…");
	renameError.hidden = !state.nameError;
	renameError.textContent = state.nameError ?? "";
	renameInput.setAttribute("aria-invalid", String(Boolean(state.nameError)));
	const notice = $("[data-profile-notice]");
	notice.hidden = !state.notice;
	notice.textContent = state.notice ?? "";
	renderError($("[data-profile-error]"), state.error ? describeError(state.error) : null);

	const linked = new Map((state.identities ?? []).map((i) => [i.provider, i]));
	const providers = [...new Set<Provider>([...(info?.providers ?? []), ...linked.keys()])];
	const rows = providers.map((provider) => {
		const li = document.createElement("li");
		const identity = linked.get(provider);
		const label = document.createElement("span");
		const name = document.createElement("strong");
		name.textContent = PROVIDER_LABELS[provider];
		label.append(name, identity ? ` · ${identity.email ?? "linked"}` : " · not linked");
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.key = `identity-${provider}`;
		if (identity) {
			const allowed = canUnlink(state, provider);
			button.className = "btn btn--small btn--danger";
			button.textContent = state.unlinking === provider ? "Unlinking…" : "Unlink";
			button.disabled = state.unlinking !== null || !allowed;
			if (!allowed)
				button.title = "Your only way to sign in. Link another or set a password first.";
			button.setAttribute("aria-label", `Unlink ${PROVIDER_LABELS[provider]}`);
			button.addEventListener("click", () => {
				if (!confirm(`Unlink ${PROVIDER_LABELS[provider]}? You won't be able to sign in with it.`))
					return;
				profileFlow?.send({ type: "unlink", provider });
			});
		} else {
			button.className = "btn btn--small";
			button.textContent = "Link";
			button.disabled = state.unlinking !== null || !info?.providers.includes(provider);
			button.setAttribute("aria-label", `Link ${PROVIDER_LABELS[provider]}`);
			button.addEventListener(
				"click",
				() =>
					void beginOAuth(
						app,
						provider,
						{ intent: "link", next: "/account" },
						button,
						$("[data-profile-error]"),
					),
			);
		}
		li.append(label, button);
		return li;
	});
	if (state.identities === null) {
		const li = document.createElement("li");
		li.className = "muted";
		li.textContent = "Loading…";
		rows.splice(0, rows.length, li);
	} else if (state.hasPassword) {
		const li = document.createElement("li");
		const label = document.createElement("span");
		const name = document.createElement("strong");
		name.textContent = "Name & password";
		label.append(name, " · set");
		li.append(label);
		rows.push(li);
	}
	$("[data-identities]").replaceChildren(...rows);
	if (state !== lastProfile && !state.renaming) {
		if (state.nameError) {
			focus(renameInput);
			announce(state.nameError);
		} else if (state.notice && state.notice !== lastProfile?.notice) {
			announce(state.notice);
		} else if (state.error && state.error !== lastProfile?.error) {
			announce(describeError(state.error).message);
		}
	}
	lastProfile = state;
}

$("[data-rename-form]").addEventListener("submit", (event) => {
	event.preventDefault();
	const state = flow.getState();
	profileFlow?.send({
		type: "rename",
		name: renameInput.value,
		current: state.kind === "ready" ? state.me.name : "",
	});
});

// Teams: one card per team; the open one shows members, invites and PINs.

/** The role new invites and PINs get; kept across re-renders. */
let inviteRole = "editor";
const teamNameInput = $<HTMLInputElement>("#team-name");
const teamNameError = $("#team-name-error");
let lastTeams: TeamsState | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	text = "",
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text) node.textContent = text;
	return node;
}

function actionButton(
	label: string,
	key: string,
	onClick: () => void,
	options: { danger?: boolean; primary?: boolean; disabled?: boolean; aria?: string } = {},
) {
	const button = el(
		"button",
		`btn btn--small${options.danger ? " btn--danger" : ""}${options.primary ? " btn--primary" : ""}`,
		label,
	);
	button.type = "button";
	button.dataset.key = key;
	button.disabled = Boolean(options.disabled);
	if (options.aria) button.setAttribute("aria-label", options.aria);
	button.addEventListener("click", onClick);
	return button;
}

function roleChooser(value: string, key: string, label: string, onChange: (role: string) => void) {
	const select = el("select", "input input--inline");
	select.dataset.key = key;
	select.setAttribute("aria-label", label);
	for (const role of ["owner", "editor", "viewer"]) {
		select.append(new Option(role[0]?.toUpperCase() + role.slice(1), role, false, role === value));
	}
	select.value = value;
	select.addEventListener("change", () => onChange(select.value));
	return select;
}

function plural(n: number, word: string) {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function memberItem(member: MemberRow, team: TeamRow, panel: TeamPanel, meId: string) {
	const li = el("li");
	const head = el("div", "people__head");
	if (member.avatarUrl) {
		const img = el("img", "avatar");
		img.alt = "";
		img.width = 24;
		img.height = 24;
		img.referrerPolicy = "no-referrer";
		img.src = member.avatarUrl;
		head.append(img);
	} else {
		const dot = el("span", "dot");
		paintDot(dot, member.color);
		head.append(dot);
	}
	head.append(el("span", "people__name", member.name));
	const me = member.id === meId;
	if (me) head.append(el("span", "badge", "you"));
	li.append(head);
	if (member.email) li.append(el("p", "people__meta", member.email));
	const actions = el("div", "people__actions");
	if (team.role === "owner" && !me) {
		actions.append(
			roleChooser(member.role, `role-${member.id}`, `Role for ${member.name}`, (role) =>
				teamsFlow?.send({ type: "role", userId: member.id, role }),
			),
			actionButton(
				"Remove",
				`remove-${member.id}`,
				() => {
					if (!confirm(`Remove ${member.name} from ${team.name}? They lose its folders.`)) return;
					teamsFlow?.send({ type: "remove", userId: member.id });
				},
				{ danger: true, disabled: panel.busy, aria: `Remove ${member.name}` },
			),
		);
		const select = actions.querySelector("select");
		if (select) select.disabled = panel.busy;
	} else {
		actions.append(el("span", "badge", member.role));
	}
	li.append(actions);
	return li;
}

function invitePart(team: TeamRow, panel: TeamPanel) {
	const part = el("div", "team__part");
	part.append(el("p", "card__eyebrow", "Invite teammates"));
	const field = el("div", "field");
	const label = el("label", "", "Role for new people");
	label.htmlFor = `invite-role-${team.id}`;
	const select = roleChooser(
		inviteRole,
		`invite-role-${team.id}`,
		"Role for new people",
		(role) => {
			inviteRole = role;
		},
	);
	select.id = `invite-role-${team.id}`;
	select.removeAttribute("aria-label");
	field.append(label, select);
	part.append(field);
	const buttons = el("div", "btn-row");
	buttons.append(
		actionButton(
			"Create invite link",
			`invite-${team.id}`,
			() => teamsFlow?.send({ type: "invite", role: inviteRole }),
			{ primary: true, disabled: panel.busy },
		),
		actionButton(
			"Create PIN",
			`pin-${team.id}`,
			() => teamsFlow?.send({ type: "pin-create", role: inviteRole }),
			{ disabled: panel.busy },
		),
	);
	part.append(buttons);
	if (panel.invite) {
		const row = el("div", "copy-row");
		const value = el("span", "copy-row__value", panel.invite.url);
		value.id = `team-invite-${team.id}`;
		const copy = el("button", "btn btn--small", "Copy");
		copy.type = "button";
		copy.dataset.copy = value.id;
		copy.dataset.key = `copy-${team.id}`;
		row.append(value, copy);
		part.append(row);
		part.append(
			el(
				"p",
				"hint",
				`Joins as ${panel.invite.role}. Works once${
					panel.invite.expiresAt ? `, until ${when(panel.invite.expiresAt)}` : ""
				}. Anyone with the link can use it, so send it privately.`,
			),
		);
	}
	if (panel.pins !== null) {
		if (panel.pinsLocked) {
			const left = panel.lockedUntil
				? formatWait((panel.lockedUntil - Date.now()) / 1000)
				: "a while";
			part.append(
				el(
					"p",
					"callout callout--error",
					`PIN entry is locked for ${left} after too many wrong PINs.`,
				),
			);
		}
		const rows = pinRows(panel.pins, panel.busy, (id) =>
			teamsFlow?.send({ type: "pin-revoke", id }),
		);
		if (rows.length > 0) {
			const table = el("table", "plain pins-table");
			const head = el("thead");
			const tr = el("tr");
			for (const title of ["PIN", "Role", "Status"]) {
				const th = el("th", "", title);
				th.scope = "col";
				tr.append(th);
			}
			const actions = el("th");
			actions.scope = "col";
			actions.append(el("span", "visually-hidden", "Actions"));
			tr.append(actions);
			head.append(tr);
			const body = el("tbody");
			body.append(...rows);
			table.append(head, body);
			part.append(table);
		} else {
			part.append(
				el(
					"p",
					"muted",
					"No PINs yet. A PIN is a short code to type at /join or in Obsidian; it works once.",
				),
			);
		}
	}
	return part;
}

function teamCard(team: TeamRow, state: Extract<TeamsState, { kind: "ready" }>, meId: string) {
	const card = el("article", "card team");
	const panel = state.open?.teamId === team.id ? state.open : null;
	const head = el("div", "team__head");
	head.append(el("h3", "card__title", team.name), el("span", "badge", team.role));
	const limit = info?.limits?.membersPerTeam;
	head.append(
		el(
			"span",
			"muted small",
			`${limit ? `${team.memberCount} of ${limit} members` : plural(team.memberCount, "member")} · ${plural(team.folders.length, "folder")}`,
		),
	);
	const toggle = actionButton(
		panel ? "Close" : "Manage",
		`toggle-${team.id}`,
		() => teamsFlow?.send(panel ? { type: "close" } : { type: "open", teamId: team.id }),
		{ aria: `${panel ? "Close" : "Manage"} ${team.name}` },
	);
	toggle.setAttribute("aria-expanded", String(Boolean(panel)));
	head.append(toggle);
	card.append(head);

	card.append(el("p", "card__eyebrow", "Shared folders"));
	if (team.folders.length > 0) {
		const list = el("ul", "workspace-list");
		for (const folder of team.folders) list.append(el("li", "", folder.name));
		card.append(list);
	} else {
		card.append(
			el(
				"p",
				"muted",
				"No shared folders yet. In Obsidian, open this team in Settings → ArcaSync and choose Share a local folder.",
			),
		);
	}
	if (!panel) return card;

	if (panel.error) {
		const error = el("p", "callout callout--error");
		renderError(error, describeError(panel.error));
		card.append(error);
	}
	if (panel.loading) {
		const loader = el("div", "loader");
		loader.setAttribute("aria-hidden", "true");
		loader.append(el("span"), el("span"), el("span"));
		card.append(loader);
		return card;
	}
	card.append(el("p", "card__eyebrow", "Members"));
	const members = el("ul", "people");
	for (const member of panel.members) members.append(memberItem(member, team, panel, meId));
	card.append(members);
	if (team.role === "owner") card.append(invitePart(team, panel));

	const danger = el("div", "btn-row");
	danger.append(
		actionButton(
			"Leave team",
			`leave-${team.id}`,
			() => {
				if (!confirm(`Leave ${team.name}? Its folders stop syncing for you.`)) return;
				teamsFlow?.send({ type: "leave" });
			},
			{ danger: true, disabled: panel.busy },
		),
	);
	if (team.role === "owner") {
		danger.append(
			actionButton(
				"Delete team",
				`delete-${team.id}`,
				() => {
					if (
						!confirm(
							`Delete ${team.name} for everyone? Its shared folders stop syncing; the files people already have stay.`,
						)
					)
						return;
					teamsFlow?.send({ type: "delete" });
				},
				{ danger: true, disabled: panel.busy },
			),
		);
	}
	card.append(danger);
	return card;
}

function renderTeams(state: TeamsState) {
	if (state.kind === "signed-out") {
		location.reload();
		return;
	}
	const ready = state.kind === "ready" ? state : null;
	$("[data-teams-loading]").hidden = state.kind !== "loading";
	$("[data-teams-retry-row]").hidden = state.kind !== "error";
	$("[data-team-create]").hidden = !ready;
	const failure = state.kind === "error" ? state.error : (ready?.error ?? null);
	renderError($("[data-teams-error]"), failure ? describeError(failure) : null);
	const notice = $("[data-teams-notice]");
	notice.hidden = !ready?.notice;
	notice.textContent = ready?.notice ?? "";
	$("[data-no-teams]").hidden = !ready || ready.teams.length > 0;

	const accountState = flow.getState();
	const meId = accountState.kind === "ready" ? accountState.profile.id : "";
	const active = document.activeElement as HTMLElement | null;
	const key = active?.dataset?.key ?? null;
	const list = $("[data-team-list]");
	list.replaceChildren(...(ready ? ready.teams.map((team) => teamCard(team, ready, meId)) : []));
	wireCopyButtons(list);
	if (key) list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();

	if (ready) {
		setBusy($<HTMLButtonElement>("[data-team-create-submit]"), ready.creating, "Creating…");
		teamNameError.hidden = !ready.nameError;
		teamNameError.textContent = ready.nameError ?? "";
		teamNameInput.setAttribute("aria-invalid", String(Boolean(ready.nameError)));
		renderError(
			$("[data-team-create-error]"),
			ready.createError ? describeError(ready.createError) : null,
		);
		const cap = info?.limits?.teamsPerUser;
		const owned = ready.teams.filter((t) => t.role === "owner").length;
		$("[data-team-limit]").textContent = cap
			? `You become its owner. You own ${owned} of ${cap} teams you can have.`
			: "You become its owner.";
		if (cap && owned >= cap) $<HTMLButtonElement>("[data-team-create-submit]").disabled = true;
		const previous = lastTeams?.kind === "ready" ? lastTeams : null;
		if (previous?.creating && !ready.creating && !ready.createError && !ready.nameError) {
			teamNameInput.value = "";
		}
		if (ready.notice && ready.notice !== previous?.notice) announce(ready.notice);
		if (ready.nameError && ready.nameError !== previous?.nameError) {
			focus(teamNameInput);
			announce(ready.nameError);
		}
		const err = ready.open?.error ?? ready.createError;
		const prevErr = previous?.open?.error ?? previous?.createError;
		if (err && err !== prevErr) announce(describeError(err).message);
	}
	lastTeams = state;
}

$("[data-team-create]").addEventListener("submit", (event) => {
	event.preventDefault();
	teamsFlow?.send({ type: "create", name: teamNameInput.value });
});
$("[data-teams-retry]").addEventListener("click", () => teamsFlow?.send({ type: "retry" }));

flow.subscribe(render);
render(flow.getState());

void loadServerInfo(app.api).then((loaded) => {
	info = loaded;
	render(flow.getState());
});

$("[data-logout]").addEventListener("click", () => flow.send({ type: "logout" }));
$("[data-password-form]").addEventListener("submit", (event) => {
	event.preventDefault();
	flow.send({
		type: "password",
		current: passwordInputs.current.value,
		next: passwordInputs.next.value,
		confirm: passwordInputs.confirm.value,
	});
});
workspaceSelect.addEventListener("change", () =>
	flow.send({ type: "pins-workspace", workspaceId: workspaceSelect.value }),
);
$("[data-pin-create]").addEventListener("click", () =>
	flow.send({ type: "pin-create", role: roleSelect.value }),
);
$("[data-pins-unlock]").addEventListener("click", () => flow.send({ type: "pins-unlock" }));
$("[data-retry]").addEventListener("click", () => flow.send({ type: "retry" }));
