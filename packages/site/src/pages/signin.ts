import "../styles/main.css";
import "../styles/flow.css";
import {
	createLoginFlow,
	createSigninFlow,
	type LoginState,
	type SigninState,
	safeNext,
} from "../flows/signin";
import { person } from "../flows/store";
import { initChrome, refreshNav } from "../lib/chrome";
import { spellCode } from "../lib/codes";
import {
	$,
	announce,
	countdown,
	focus,
	paintDot,
	renderError,
	setBusy,
	showState,
} from "../lib/dom";
import { describeError } from "../lib/errors";
import { obsidianApproveLink } from "../lib/invite";
import { normalizePin, passwordProblem } from "../lib/passwords";
import { beginOAuth, renderProviderButtons } from "../lib/providers";
import { isProvider, loadServerInfo, PROVIDER_LABELS } from "../lib/serverInfo";

const app = initChrome();
const root = $("[data-flow]");
const query = new URLSearchParams(location.search);
const next = safeNext(query.get("next"));
/** `/signin?provider=google&next=…` (the plugin opens this): go straight to that provider. */
const wanted = query.get("provider");
if (wanted !== null) {
	history.replaceState(
		null,
		"",
		next === "/account" ? "/signin" : `/signin?next=${encodeURIComponent(next)}`,
	);
}
const device = app.device();
const flow = createSigninFlow({ api: app.api, session: app.session, device: () => device, next });

const login = createLoginFlow({ api: app.api, session: app.session, device: () => device, next });
let lastKind = "";
let stopCountdown: (() => void) | null = null;
let stopLoginCooldown: (() => void) | null = null;

function showApproved(user: { name: string; color: string }, to: string) {
	showState(root, "approved");
	$("[data-approved-text]").textContent = `Signed in as ${user.name}`;
	paintDot($("[data-user-dot]"), user.color);
	refreshNav(app);
	announce(`Signed in as ${user.name}.`);
	window.setTimeout(() => location.assign(to), 800);
}

function render(state: SigninState) {
	const changed = state.kind !== lastKind;
	lastKind = state.kind;
	const section = showState(root, state.kind);
	if (state.kind !== "waiting") {
		stopCountdown?.();
		stopCountdown = null;
	}
	switch (state.kind) {
		case "idle":
			renderError($("[data-start-error]"), state.error ? describeError(state.error) : null);
			if (state.error) announce(describeError(state.error).message);
			break;
		case "waiting": {
			const code = $("[data-code]");
			code.textContent = state.userCode;
			code.setAttribute("aria-label", `Code: ${spellCode(state.userCode)}`);
			$<HTMLAnchorElement>("[data-open-approve]").href = obsidianApproveLink(state.userCode);
			$("[data-device-name]").textContent = device.name;
			if (changed) {
				stopCountdown = countdown($("[data-expires]"), state.expiresAt);
				announce(`Your code is ${spellCode(state.userCode)}. Waiting for approval.`);
			}
			break;
		}
		case "approved":
			showApproved(state.user, state.next);
			break;
		case "denied":
		case "expired":
			if (changed) {
				const heading = section?.querySelector<HTMLElement>("h1") ?? null;
				announce(heading?.textContent ?? "");
				focus(heading);
			}
			break;
		case "starting":
			break;
	}
}

flow.subscribe(render);
render(flow.getState());

const loginName = $<HTMLInputElement>("#login-name");
const loginPassword = $<HTMLInputElement>("#login-password");
const loginSubmit = $<HTMLButtonElement>("[data-login-submit]");

function renderLogin(state: LoginState) {
	if (state.kind === "done") {
		showApproved(state.user, state.next);
		return;
	}
	setBusy(loginSubmit, state.submitting, "Signing in…");
	const fields = [
		[loginName, $("#login-name-error"), state.nameError],
		[loginPassword, $("#login-password-error"), state.passwordError],
	] as const;
	let first: HTMLInputElement | null = null;
	for (const [input, error, message] of fields) {
		error.hidden = !message;
		error.textContent = message ?? "";
		input.setAttribute("aria-invalid", String(Boolean(message)));
		if (message && !first) first = input;
	}
	const copy = state.error ? describeError(state.error) : null;
	renderError($("[data-login-error]"), copy);
	stopLoginCooldown?.();
	stopLoginCooldown = null;
	const cooling = state.cooldownUntil !== null;
	$("[data-login-cooldown]").hidden = !cooling;
	if (cooling && state.cooldownUntil !== null) {
		loginSubmit.disabled = true;
		stopLoginCooldown = countdown($("[data-login-cooldown-time]"), state.cooldownUntil);
	}
	if (first && !state.submitting) focus(first);
	if (copy && !state.submitting) {
		announce(copy.message);
		if (state.error?.code === "invalid_credentials") {
			loginPassword.value = "";
			focus(loginPassword);
		}
	}
}

login.subscribe(renderLogin);
renderLogin(login.getState());

$("[data-login-form]").addEventListener("submit", (event) => {
	event.preventDefault();
	login.send({ type: "login", name: loginName.value, password: loginPassword.value });
});

$("[data-start]").addEventListener("click", () => flow.send({ type: "start" }));
$("[data-cancel]").addEventListener("click", () => {
	flow.send({ type: "cancel" });
	focus($("[data-start]"));
});
for (const button of document.querySelectorAll("[data-restart]")) {
	button.addEventListener("click", () => flow.send({ type: "start" }));
}
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") flow.send({ type: "visible" });
});

// Forgot password: name + an admin-issued reset PIN + a new password.
const resetForm = $<HTMLFormElement>("[data-reset-form]");
const forgot = $<HTMLButtonElement>("[data-forgot]");
const reset = {
	name: $<HTMLInputElement>("#reset-name"),
	pin: $<HTMLInputElement>("#reset-pin"),
	password: $<HTMLInputElement>("#reset-password"),
	confirm: $<HTMLInputElement>("#reset-confirm"),
};
const resetSubmit = $<HTMLButtonElement>("[data-reset-submit]");

forgot.addEventListener("click", () => {
	resetForm.hidden = !resetForm.hidden;
	forgot.setAttribute("aria-expanded", String(!resetForm.hidden));
	if (!resetForm.hidden) {
		if (!reset.name.value) reset.name.value = loginName.value;
		focus(reset.name.value ? reset.pin : reset.name);
	}
});

function fieldError(input: HTMLInputElement, message: string | null) {
	const error = $(`#${input.id}-error`);
	error.hidden = !message;
	error.textContent = message ?? "";
	input.setAttribute("aria-invalid", String(Boolean(message)));
}

resetForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	if (resetSubmit.disabled) return;
	const name = reset.name.value.trim();
	const pin = normalizePin(reset.pin.value) ?? "";
	const errors: [HTMLInputElement, string | null][] = [
		[reset.name, name ? null : "Enter your name."],
		[reset.pin, pin ? null : "Enter the reset PIN (4 or 6 digits)."],
		[reset.password, passwordProblem(reset.password.value)],
		[reset.confirm, null],
	];
	if (!errors[2]?.[1] && reset.password.value !== reset.confirm.value) {
		errors[3] = [reset.confirm, "The two passwords differ."];
	}
	for (const [input, message] of errors) fieldError(input, message);
	renderError($("[data-reset-error]"), null);
	const first = errors.find(([, message]) => message);
	if (first) {
		focus(first[0]);
		announce(first[1] ?? "");
		return;
	}
	setBusy(resetSubmit, true, "Saving…");
	const res = await app.api.call<{ sessionToken?: unknown; user?: unknown }>(
		"POST",
		"/api/auth/password/reset",
		{ body: { name, pin, password: reset.password.value, device } },
	);
	setBusy(resetSubmit, false);
	const user = res.ok ? person(res.data.user) : null;
	if (res.ok && typeof res.data.sessionToken === "string" && user) {
		app.session.set(res.data.sessionToken);
		showApproved(user, next);
		return;
	}
	const failure = res.ok ? { code: "server_error", message: "Unexpected response" } : res;
	if (failure.code === "invalid_pin") {
		fieldError(reset.pin, "That name and reset PIN don't match, or the PIN expired.");
		focus(reset.pin);
		announce("That name and reset PIN don't match, or the PIN expired.");
		return;
	}
	if (failure.code === "weak_password") {
		fieldError(reset.password, failure.message || "Pick another password.");
		focus(reset.password);
		return;
	}
	const copy = describeError(failure);
	renderError($("[data-reset-error]"), copy);
	announce(copy.message);
});

// Google / GitHub, when the server offers them.
const providersCard = $("[data-providers]");
const oauthError = $("[data-oauth-error]");

void (async () => {
	if (isProvider(wanted) && app.session.token()) {
		// Already signed in here: /approve shows who, and the device, before anything happens.
		location.replace(next);
		return;
	}
	const info = await loadServerInfo(app.api);
	if (info.providers.length > 0) {
		providersCard.hidden = false;
		$("[data-providers-title]").textContent =
			`With ${info.providers.map((p) => PROVIDER_LABELS[p]).join(" or ")}`;
		$("[data-providers-hint]").textContent =
			info.signups === "open"
				? "New to ArcaSync? This creates your account."
				: "For accounts that have linked it. New accounts on this server need an invite.";
	}
	const buttons = renderProviderButtons(
		$("[data-provider-buttons]"),
		info.providers,
		(provider, button) =>
			void beginOAuth(app, provider, { intent: "signin", next }, button, oauthError),
	);
	if (wanted === null) return;
	const button = buttons.find((b) => b.dataset.provider === wanted);
	if (isProvider(wanted) && button) {
		void beginOAuth(app, wanted, { intent: "signin", next }, button, oauthError);
	} else {
		providersCard.hidden = false;
		renderError(oauthError, {
			message: isProvider(wanted)
				? `This server doesn't offer sign-in with ${PROVIDER_LABELS[wanted]}. Use another way below.`
				: "Unknown sign-in method. Use one of the ways below.",
		});
	}
})();
