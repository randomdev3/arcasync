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
import { DISABLED_COPY, describeError } from "../lib/errors";
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
		case "joined": {
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
			if (state.kind === "error" || state.kind === "joined" || state.kind === "signed-in")
				focus(heading);
		}
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

$("[data-redeem]").addEventListener("click", () => flow.send({ type: "redeem" }));
$("[data-not-me]").addEventListener("click", () => {
	flow.send({ type: "not-me" });
	refreshNav(app);
});
