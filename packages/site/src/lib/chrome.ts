import type { DeviceInfo } from "@arcasync/shared";
import { type Api, createApi, MISCONFIGURED_EVENT, SIGNED_OUT_EVENT } from "./api";
import { browserDevice } from "./device";
import { $, wireCopyButtons } from "./dom";
import { API_URL } from "./env";
import { MISCONFIGURED_COPY } from "./errors";
import { createSession, type KeyValue, type Session, safeStorage } from "./session";
import { initThemeToggle } from "./theme";

export interface App {
	api: Api;
	session: Session;
	/** Session storage (the pending invite). */
	pending: KeyValue;
	device: () => DeviceInfo;
	/** The relay's base URL: what the plugin's Server URL is set to. */
	relay: string;
}

function createApp(): App {
	const local = safeStorage(() => window.localStorage);
	const session = createSession(local);
	const api = createApi({
		base: API_URL,
		fetch: (input, init) => window.fetch(input, init),
		session,
		onSignedOut: () => window.dispatchEvent(new Event(SIGNED_OUT_EVENT)),
		onMisconfigured: () => window.dispatchEvent(new Event(MISCONFIGURED_EVENT)),
	});
	return {
		api,
		session,
		pending: safeStorage(() => window.sessionStorage),
		device: () => browserDevice(navigator, local, () => crypto.randomUUID()),
		relay: API_URL,
	};
}

/** Header nav: "Account" when this browser holds a session, otherwise "Sign in". */
function renderSessionLink(session: Session): void {
	const link = document.querySelector<HTMLAnchorElement>("[data-session-link]");
	if (!link) return;
	const signedIn = session.token() !== null;
	link.textContent = signedIn ? "Account" : "Sign in";
	link.href = signedIn ? "/account" : "/signin";
	const here = location.pathname.replace(/\.html$/, "");
	if (link.pathname === here) link.setAttribute("aria-current", "page");
	else link.removeAttribute("aria-current");
}

/** Shared page setup: theme toggle, nav state, the misconfigured banner, copy buttons. */
export function initChrome(): App {
	const app = createApp();
	initThemeToggle();
	renderSessionLink(app.session);
	const here = location.pathname.replace(/\.html$/, "");
	for (const link of document.querySelectorAll<HTMLAnchorElement>(
		".site-nav a:not([data-session-link])",
	)) {
		if (link.pathname === here) link.setAttribute("aria-current", "page");
	}
	window.addEventListener(SIGNED_OUT_EVENT, () => renderSessionLink(app.session));
	window.addEventListener(MISCONFIGURED_EVENT, () => {
		const banner = $("[data-banner]");
		banner.textContent = MISCONFIGURED_COPY;
		banner.hidden = false;
	});
	wireCopyButtons();
	return app;
}

/** Re-reads the nav after a sign-in or sign-out on this page. */
export function refreshNav(app: App): void {
	renderSessionLink(app.session);
}
