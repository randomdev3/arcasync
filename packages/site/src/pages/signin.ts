import "../styles/main.css";
import "../styles/flow.css";
import { createSigninFlow, type SigninState, safeNext } from "../flows/signin";
import { initChrome, refreshNav } from "../lib/chrome";
import { spellCode } from "../lib/codes";
import { $, announce, countdown, focus, paintDot, renderError, showState } from "../lib/dom";
import { describeError } from "../lib/errors";
import { obsidianApproveLink } from "../lib/invite";

const app = initChrome();
const root = $("[data-flow]");
const next = safeNext(new URLSearchParams(location.search).get("next"));
const device = app.device();
const flow = createSigninFlow({ api: app.api, session: app.session, device: () => device, next });

let lastKind = "";
let stopCountdown: (() => void) | null = null;

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
			$("[data-approved-text]").textContent = `Signed in as ${state.user.name}`;
			paintDot($("[data-user-dot]"), state.user.color);
			refreshNav(app);
			announce(`Signed in as ${state.user.name}.`);
			window.setTimeout(() => location.assign(state.next), 800);
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
