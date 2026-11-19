import "../styles/main.css";
import "../styles/flow.css";
import { createJoinFlow, type JoinState } from "../flows/join";
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

const app = initChrome();
const root = $("[data-flow]");

// Take the token out of the address bar, history and screenshots; a reload resumes from
// session storage.
const token = inviteFromLocation(location.search, location.hash);
if (location.search || location.hash) history.replaceState(null, "", "/join");

const flow = createJoinFlow(
	{ api: app.api, session: app.session, pending: app.pending, device: app.device },
	token,
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
const nameInput = $<HTMLInputElement>("#name");
const nameError = $("#name-error");
const submit = $<HTMLButtonElement>("[data-join-submit]");
let lastKind = "";
let stopCooldown: (() => void) | null = null;

function render(state: JoinState) {
	const changed = state.kind !== lastKind;
	lastKind = state.kind;
	const section = showState(root, state.kind);

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
				announce("Workspace added.");
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
