import "../styles/main.css";
import "../styles/flow.css";
import { type CallbackState, callbackParams, createCallbackFlow } from "../flows/callback";
import { safeNext } from "../flows/signin";
import { initChrome, refreshNav } from "../lib/chrome";
import { $, announce, focus, paintDot, renderError, showState } from "../lib/dom";
import { OAUTH_REDEEM_KEY } from "../lib/oauth";

const app = initChrome();
const root = $("[data-flow]");

// The handoff is single-use, but keep it out of history and screenshots all the same.
const params = callbackParams(location.search);
history.replaceState(null, "", "/auth/callback");

const flow = createCallbackFlow(
	{ api: app.api, session: app.session, pending: app.pending, device: app.device },
	params,
);

function render(state: CallbackState) {
	const section = showState(root, state.kind);
	switch (state.kind) {
		case "done":
			$("[data-done-kicker]").textContent = state.created ? "account created" : "signed in";
			$("[data-done-text]").textContent =
				`${state.created ? "Welcome" : "Signed in as"} ${state.user.name}`;
			paintDot($("[data-user-dot]"), state.user.color);
			refreshNav(app);
			announce(`Signed in as ${state.user.name}.`);
			location.replace(state.next);
			break;
		case "error": {
			// A /join sign-in that failed: the invite or PIN is still waiting there.
			const fromJoin = app.pending.getItem(OAUTH_REDEEM_KEY) !== null;
			app.pending.removeItem(OAUTH_REDEEM_KEY);
			// Still signed in (a failed Link): go back to where it started, not to sign-in.
			const retry = $<HTMLAnchorElement>("[data-retry]");
			const signedIn = app.session.token() !== null;
			retry.href = signedIn ? safeNext(params.next) : state.retry;
			retry.textContent = signedIn ? "Go back" : "Try again";
			$("[data-join]").hidden = !(fromJoin || state.code === "signup_closed");
			renderError($("[data-error]"), { message: state.message });
			const heading = section?.querySelector<HTMLElement>("h1") ?? null;
			announce(`${heading?.textContent ?? ""}. ${state.message}`);
			focus(heading);
			break;
		}
		case "exchanging":
			break;
	}
}

flow.subscribe(render);
render(flow.getState());
