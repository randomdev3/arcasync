import "../styles/main.css";
import "../styles/flow.css";
import { type ApproveState, createApproveFlow } from "../flows/approve";
import { initChrome, refreshNav } from "../lib/chrome";
import { normalizeUserCode } from "../lib/codes";
import { platformLabel } from "../lib/device";
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

const app = initChrome();
const root = $("[data-flow]");

// A code is not secret but short-lived: keep the normalised one in the URL so a reload works.
const urlCode = normalizeUserCode(new URLSearchParams(location.search).get("code") ?? "");
history.replaceState(null, "", urlCode ? `/approve?code=${urlCode}` : "/approve");

const flow = createApproveFlow({ api: app.api, session: app.session }, urlCode);
const input = $<HTMLInputElement>("#code");
const codeError = $("#code-error");
const lookupButton = $<HTMLButtonElement>("[data-lookup]");
let lastKind = "";
let stopTimers: (() => void)[] = [];

function render(state: ApproveState) {
	const changed = state.kind !== lastKind;
	lastKind = state.kind;
	for (const stop of stopTimers) stop();
	stopTimers = [];
	const section = showState(root, state.kind);

	switch (state.kind) {
		case "needs-session": {
			const notice = $("[data-session-notice]");
			notice.hidden = !state.notice;
			notice.textContent = state.notice ?? "";
			$("[data-option-obsidian]").hidden = !state.code;
			if (state.code)
				$<HTMLAnchorElement>("[data-open-approve]").href = obsidianApproveLink(state.code);
			const back = state.code ? `/approve?code=${state.code}` : "/approve";
			$<HTMLAnchorElement>("[data-signin-link]").href = `/signin?next=${encodeURIComponent(back)}`;
			refreshNav(app);
			if (state.notice) announce(state.notice);
			break;
		}
		case "ready": {
			$("[data-me-name]").textContent = state.me.name;
			paintDot($("[data-me-dot]"), state.me.color);
			if (changed || !state.busy) input.value = state.code;
			setBusy(lookupButton, state.busy, "Looking up…");
			codeError.hidden = !state.fieldError;
			codeError.textContent = state.fieldError ?? "";
			input.setAttribute("aria-invalid", String(Boolean(state.fieldError)));
			// The flow's own rate-limit copy ("Too many lookups…") wins over the shared one.
			renderError(
				$("[data-ready-error]"),
				state.error
					? {
							message:
								state.error.code === "rate_limited"
									? state.error.message
									: describeError(state.error).message,
						}
					: null,
			);
			const cooling = state.cooldownUntil !== null;
			$("[data-cooldown]").hidden = !cooling;
			if (cooling && state.cooldownUntil !== null) {
				lookupButton.disabled = true;
				stopTimers.push(countdown($("[data-cooldown-time]"), state.cooldownUntil));
			}
			if (state.fieldError && !state.busy) {
				focus(input);
				announce(state.fieldError);
			} else if (state.error) {
				announce(
					state.error.code === "rate_limited"
						? state.error.message
						: describeError(state.error).message,
				);
			}
			break;
		}
		case "confirm": {
			$("[data-device-name]").textContent = state.device.name;
			$("[data-device-platform]").textContent = platformLabel(state.device.platform);
			$("[data-confirm-me]").textContent = state.me.name;
			paintDot($("[data-confirm-dot]"), state.me.color);
			$("[data-confirm-code]").textContent = state.code;
			stopTimers.push(countdown($("[data-expires]"), state.expiresAt));
			setBusy($<HTMLButtonElement>("[data-approve]"), state.busy === "approving", "Approving…");
			setBusy($<HTMLButtonElement>("[data-deny]"), state.busy === "denying", "Denying…");
			if (state.busy) {
				$<HTMLButtonElement>("[data-approve]").disabled = true;
				$<HTMLButtonElement>("[data-deny]").disabled = true;
			}
			renderError($("[data-confirm-error]"), state.error ? describeError(state.error) : null);
			if (changed) announce(`${state.device.name} wants to sign in as ${state.me.name}.`);
			break;
		}
		case "approved":
			$("[data-approved-device]").textContent = state.device.name;
			break;
		case "error":
			renderError($("[data-page-error]"), describeError(state.error));
			break;
		case "checking":
		case "denied":
			break;
	}

	if (changed && ["confirm", "approved", "denied", "error"].includes(state.kind)) {
		const heading = section?.querySelector<HTMLElement>("h1") ?? null;
		if (state.kind !== "confirm") announce(heading?.textContent ?? "");
		focus(heading);
	}
}

flow.subscribe(render);
render(flow.getState());

$("[data-lookup-form]").addEventListener("submit", (event) => {
	event.preventDefault();
	flow.send({ type: "lookup", input: input.value });
});
$("[data-approve]").addEventListener("click", () => flow.send({ type: "approve" }));
$("[data-deny]").addEventListener("click", () => flow.send({ type: "deny" }));
$("[data-retry]").addEventListener("click", () => flow.send({ type: "retry" }));
for (const button of document.querySelectorAll("[data-again]")) {
	button.addEventListener("click", () => {
		flow.send({ type: "again" });
		history.replaceState(null, "", "/approve");
		focus(input);
	});
}
