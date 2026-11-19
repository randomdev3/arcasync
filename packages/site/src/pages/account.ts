import "../styles/main.css";
import "../styles/flow.css";
import {
	type AccountState,
	createAccountFlow,
	type PasswordPanel,
	type PinItem,
} from "../flows/account";
import { initChrome, refreshNav } from "../lib/chrome";
import { $, announce, focus, paintDot, renderError, setBusy, showState } from "../lib/dom";
import { describeError, formatWait } from "../lib/errors";

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

	const now = Date.now();
	const rows = panel.items.map((pin) => {
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
			revoke.disabled = panel.busy;
			revoke.setAttribute("aria-label", `Revoke PIN ${pin.pin}`);
			revoke.addEventListener("click", () => flow.send({ type: "pin-revoke", id: pin.id }));
			actions.append(revoke);
		}
		row.append(actions);
		return row;
	});
	$("[data-pins-list]").replaceChildren(...rows);
	$("[data-pins-table]").hidden = panel.loading || rows.length === 0;
	$("[data-no-pins]").hidden = panel.loading || rows.length > 0;
}

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
			$("[data-owner-note]").hidden = !(
				state.me.isAdmin || state.workspaces.some((w) => w.role === "owner")
			);
			setBusy($<HTMLButtonElement>("[data-logout]"), state.signingOut, "Signing out…");
			renderPassword(state);
			renderPins(state);
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

flow.subscribe(render);
render(flow.getState());

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
