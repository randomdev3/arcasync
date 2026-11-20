import "../styles/main.css";
import "../styles/flow.css";
import { createJoinFlow, type JoinState, PIN_RULE_COPY } from "../flows/join";
import { initChrome, refreshNav } from "../lib/chrome";
import {
	$,
	announce,
	countdown,
	focus,
	paintDot,
	renderError,
	renderWorkspaces,
	setBusy,
	showState,
} from "../lib/dom";
import { DISABLED_COPY, describeError, formatWait } from "../lib/errors";
import { inviteFromLocation, obsidianInviteLink } from "../lib/invite";
import { saveRedeem, takeRedeem } from "../lib/oauth";
import { normalizePin } from "../lib/passwords";
import { beginOAuth, renderProviderButtons } from "../lib/providers";
import { loadServerInfo, type Provider } from "../lib/serverInfo";
import { PENDING_INVITE_KEY } from "../lib/session";

const app = initChrome();
const root = $("[data-flow]");

// Take the token (or PIN) out of the address bar, history and screenshots; a reload resumes
// from session storage.
const token = inviteFromLocation(location.search, location.hash);
const urlPin = normalizePin(new URLSearchParams(location.search).get("pin") ?? "");
if (location.search || location.hash) history.replaceState(null, "", "/join");

// Back from Google or GitHub: redeem what this tab asked for, once, without another click.
const redeem = takeRedeem(app.pending);
const effectiveToken = token ?? app.pending.getItem(PENDING_INVITE_KEY);
const auto =
	app.session.token() !== null &&
	((redeem?.kind === "invite" && redeem.token === effectiveToken) ||
		(redeem?.kind === "pin" && redeem.pin === urlPin));

const flow = createJoinFlow(
	{ api: app.api, session: app.session, pending: app.pending, device: app.device },
	token,
	{ pin: urlPin, redeem },
);

const PAGE_ERRORS: Record<string, { title: string; action: string }> = {
	not_found: {
		title: "This invite doesn't exist or was revoked",
		action: "Ask whoever sent it for a new one.",
	},
	invite_expired: {
		title: "This invite has expired",
		action: "Ask whoever sent it for a new one.",
	},
	invite_used: {
		title: "This invite has already been used",
		action: "If that was you, sign in instead. Otherwise ask for a new invite.",
	},
	forbidden: { title: DISABLED_COPY, action: "" },
};

const pinInput = $<HTMLInputElement>("#pin");
const pinFields = {
	pin: [pinInput, $("#pin-error")],
	name: [$<HTMLInputElement>("#pin-name"), $("#pin-name-error")],
	password: [$<HTMLInputElement>("#pin-password"), $("#pin-password-error")],
	confirm: [$<HTMLInputElement>("#pin-confirm"), $("#pin-confirm-error")],
} as const;
const pinSubmit = $<HTMLButtonElement>("[data-pin-submit]");
if (urlPin) pinInput.value = urlPin;
let providers: Provider[] = [];
let signupsOpen = false;
const nameInput = $<HTMLInputElement>("#name");
const nameError = $("#name-error");
const submit = $<HTMLButtonElement>("[data-join-submit]");
let lastKind = "";
let stopCooldown: (() => void) | null = null;

/** The Google / GitHub blocks, once the server says which it offers. */
function renderProviderBlocks(state: JoinState) {
	const any = providers.length > 0;
	$("[data-start]").hidden = !(signupsOpen && any);
	$("[data-choose-providers]").hidden = !any;
	$("[data-pin-providers]").hidden = !any || (state.kind === "pin" && state.signedIn);
}

function render(state: JoinState) {
	const changed = state.kind !== lastKind;
	lastKind = state.kind;
	const section = showState(root, state.kind);
	renderProviderBlocks(state);

	switch (state.kind) {
		case "no-invite": {
			const error = $("#paste-error");
			error.hidden = !state.pasteError;
			error.textContent = state.pasteError ?? "";
			$("#paste").setAttribute("aria-invalid", String(Boolean(state.pasteError)));
			if (state.pasteError) focus($("#paste"));
			break;
		}
		case "choose": {
			$<HTMLAnchorElement>("[data-open-obsidian]").href = obsidianInviteLink(
				app.relay,
				state.token,
			);
			setBusy(submit, state.submitting, "Creating…");
			nameError.hidden = !state.nameError;
			nameError.textContent = state.nameError ?? "";
			nameInput.setAttribute("aria-invalid", String(Boolean(state.nameError)));
			renderError($("[data-form-error]"), state.formError ? describeError(state.formError) : null);
			stopCooldown?.();
			stopCooldown = null;
			const cooling = state.cooldownUntil !== null;
			$("[data-cooldown]").hidden = !cooling;
			if (cooling && state.cooldownUntil !== null) {
				submit.disabled = true;
				stopCooldown = countdown($("[data-cooldown-time]"), state.cooldownUntil);
			}
			if (state.nameError && !state.submitting) {
				focus(nameInput);
				announce(state.nameError);
			} else if (state.formError) {
				announce(describeError(state.formError).message);
			}
			break;
		}
		case "pin": {
			for (const el of document.querySelectorAll<HTMLElement>("[data-pin-account]")) {
				el.hidden = state.signedIn;
			}
			$("[data-pin-lede-new]").hidden = state.signedIn;
			$("[data-pin-lede-signed-in]").hidden = !state.signedIn;
			setBusy(pinSubmit, state.submitting, state.signedIn ? "Adding…" : "Creating…");
			if (!state.submitting)
				pinSubmit.textContent = state.signedIn ? "Add workspace" : "Create account";
			const errors = {
				pin: state.pinError,
				name: state.nameError,
				password: state.passwordError,
				confirm: state.confirmError,
			};
			let first: { input: HTMLInputElement; message: string } | null = null;
			for (const [key, [input, error]] of Object.entries(pinFields)) {
				const message = errors[key as keyof typeof errors];
				error.hidden = !message;
				error.textContent = message ?? "";
				input.setAttribute("aria-invalid", String(Boolean(message)));
				if (message && !first) first = { input, message };
			}
			renderError(
				$("[data-pin-form-error]"),
				state.formError ? describeError(state.formError) : null,
			);
			stopCooldown?.();
			stopCooldown = null;
			const cooling = state.cooldownUntil !== null;
			if (cooling && state.cooldownUntil !== null) pinSubmit.disabled = true;
			// A short wait counts down; a long one (the 24 h lock) is said in the error instead.
			const short = cooling && (state.cooldownUntil ?? 0) - Date.now() < 3600_000;
			$("[data-pin-cooldown]").hidden = !short;
			if (short && state.cooldownUntil !== null) {
				stopCooldown = countdown($("[data-pin-cooldown-time]"), state.cooldownUntil);
			}
			if (first && !state.submitting) {
				focus(first.input);
				announce(first.message);
			} else if (state.formError) {
				const copy = describeError(state.formError);
				const until = state.cooldownUntil;
				announce(
					until && !short
						? `${copy.message} Locked for ${formatWait((until - Date.now()) / 1000)}.`
						: copy.message,
				);
			}
			break;
		}
		case "pin-redeemed":
			renderWorkspaces($("[data-pin-redeemed-list]"), state.workspaces);
			refreshNav(app);
			if (auto) location.assign("/account");
			break;
		case "joined": {
			$("[data-steps-password]").hidden = !state.withPassword;
			$("[data-steps-code]").hidden = Boolean(state.withPassword);
			$("[data-welcome]").textContent =
				`${state.welcomeBack ? "Welcome back" : "Welcome"}, ${state.user.name}`;
			paintDot($("[data-user-dot]"), state.user.color);
			renderWorkspaces($("[data-workspaces]"), state.workspaces);
			refreshNav(app);
			break;
		}
		case "signed-in": {
			$("[data-me-name]").textContent = state.me.name;
			paintDot($("[data-me-dot]"), state.me.color);
			setBusy($<HTMLButtonElement>("[data-redeem]"), state.redeeming, "Adding…");
			renderError(
				$("[data-redeem-error]"),
				state.formError ? describeError(state.formError) : null,
			);
			const done = state.redeemed !== null;
			$("[data-redeem-form]").hidden = done;
			$("[data-redeemed]").hidden = !done;
			if (state.redeemed) {
				renderWorkspaces($("[data-redeemed-list]"), state.redeemed);
				announce("You joined the team.");
				if (auto) location.assign("/account");
			}
			break;
		}
		case "error": {
			const copy = PAGE_ERRORS[state.error.code];
			const shared = describeError(state.error);
			$("[data-error-title]").textContent = copy?.title ?? shared.message;
			$("[data-error-action]").textContent = copy?.action ?? "";
			$("[data-error-signin]").hidden = state.error.code !== "invite_used";
			break;
		}
		case "checking-session":
			break;
	}

	if (changed && lastKind !== "") {
		const heading = section?.querySelector<HTMLElement>("h1") ?? null;
		if (heading) announce(heading.textContent ?? "");
		if (document.activeElement !== nameInput || state.kind !== "choose") {
			if (
				state.kind === "error" ||
				state.kind === "joined" ||
				state.kind === "signed-in" ||
				state.kind === "pin-redeemed"
			)
				focus(heading);
		}
		if (state.kind === "pin") focus(pinInput);
	}
}

flow.subscribe(render);
render(flow.getState());

$("[data-paste-form]").addEventListener("submit", (event) => {
	event.preventDefault();
	flow.send({
		type: "paste",
		input: $<HTMLInputElement>("#paste").value,
		site: location.origin,
		relay: app.relay,
	});
});

$("[data-join-form]").addEventListener("submit", (event) => {
	event.preventDefault();
	flow.send({ type: "submit", name: nameInput.value });
});

$("[data-use-pin]").addEventListener("click", () => flow.send({ type: "use-pin" }));
$("[data-use-link]").addEventListener("click", () => {
	flow.send({ type: "use-link" });
	focus($("#paste"));
});
$("[data-pin-form]").addEventListener("submit", (event) => {
	event.preventDefault();
	flow.send({
		type: "pin-submit",
		pin: pinInput.value,
		name: pinFields.name[0].value,
		password: pinFields.password[0].value,
		confirm: pinFields.confirm[0].value,
	});
});

$("[data-redeem]").addEventListener("click", () => flow.send({ type: "redeem" }));
$("[data-not-me]").addEventListener("click", () => {
	flow.send({ type: "not-me" });
	refreshNav(app);
});

// --- Google / GitHub ---------------------------------------------------------------------

/** `next` is capped at 300 characters; a long token rides in session storage instead. */
const joinNext = (query: string) => {
	const next = `/join?${query}`;
	return next.length <= 300 ? next : "/join";
};

function pickForInvite(provider: Provider, button: HTMLButtonElement) {
	const state = flow.getState();
	if (state.kind !== "choose") return;
	saveRedeem(app.pending, { kind: "invite", token: state.token });
	const next = joinNext(`invite=${state.token}`);
	void beginOAuth(
		app,
		provider,
		{ intent: "signin", next },
		button,
		$("[data-choose-oauth-error]"),
	).then((left) => left || takeRedeem(app.pending));
}

function pickForPin(provider: Provider, button: HTMLButtonElement) {
	const pin = normalizePin(pinInput.value);
	const error = pinFields.pin[1];
	if (!pin) {
		error.hidden = false;
		error.textContent = PIN_RULE_COPY;
		pinInput.setAttribute("aria-invalid", "true");
		focus(pinInput);
		announce(PIN_RULE_COPY);
		return;
	}
	saveRedeem(app.pending, { kind: "pin", pin });
	void beginOAuth(
		app,
		provider,
		{ intent: "signin", next: joinNext(`pin=${pin}`) },
		button,
		$("[data-pin-oauth-error]"),
	).then((left) => left || takeRedeem(app.pending));
}

void loadServerInfo(app.api).then((info) => {
	providers = info.providers;
	signupsOpen = info.signups === "open";
	renderProviderButtons($("[data-choose-provider-buttons]"), providers, pickForInvite);
	renderProviderButtons($("[data-pin-provider-buttons]"), providers, pickForPin);
	renderProviderButtons(
		$("[data-start-providers]"),
		providers,
		(provider, button) =>
			void beginOAuth(
				app,
				provider,
				{ intent: "signin", next: "/account" },
				button,
				$("[data-start-error]"),
			),
		(name) => `Sign up with ${name}`,
	);
	renderProviderBlocks(flow.getState());
});
