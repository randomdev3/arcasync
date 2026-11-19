import "../styles/main.css";
import "../styles/flow.css";
import { type AccountState, createAccountFlow } from "../flows/account";
import { initChrome, refreshNav } from "../lib/chrome";
import { $, announce, focus, paintDot, renderError, setBusy, showState } from "../lib/dom";
import { describeError } from "../lib/errors";

const app = initChrome();
const root = $("[data-flow]");
const flow = createAccountFlow({ api: app.api, session: app.session });
let lastKind = "";

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
$("[data-retry]").addEventListener("click", () => flow.send({ type: "retry" }));
