import type { App } from "./chrome";
import { announce, renderError, setBusy } from "./dom";
import { describeError } from "./errors";
import { browserCrypto, OAUTH_ERRORS, oauthErrorCopy, startOAuth } from "./oauth";
import { PROVIDER_LABELS, type Provider } from "./serverInfo";

/** "Continue with Google" / "Continue with GitHub" buttons, one per provider the server offers. */
export function renderProviderButtons(
	row: HTMLElement,
	providers: Provider[],
	onPick: (provider: Provider, button: HTMLButtonElement) => void,
	label: (name: string) => string = (name) => `Continue with ${name}`,
): HTMLButtonElement[] {
	const buttons = providers.map((provider) => {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "btn";
		button.dataset.provider = provider;
		button.textContent = label(PROVIDER_LABELS[provider]);
		button.addEventListener("click", () => onPick(provider, button));
		return button;
	});
	row.replaceChildren(...buttons);
	return buttons;
}

/**
 * Starts the provider's sign-in and leaves the page for it; on failure the button comes back and
 * the error shows in `errorBox`.
 */
export async function beginOAuth(
	app: App,
	provider: Provider,
	options: { intent: "signin" | "link"; next: string },
	button: HTMLButtonElement | null,
	errorBox: HTMLElement,
): Promise<boolean> {
	if (button) setBusy(button, true, `Opening ${PROVIDER_LABELS[provider]}…`);
	renderError(errorBox, null);
	const res = await startOAuth(
		{ api: app.api, pending: app.pending, crypto: browserCrypto },
		provider,
		options,
	);
	if (res.ok) {
		// Back from the provider via the back/forward cache: the button works again.
		window.addEventListener(
			"pageshow",
			(event) => {
				if (event.persisted && button) setBusy(button, false);
			},
			{ once: true },
		);
		location.assign(res.url);
		return true;
	}
	if (button) setBusy(button, false);
	const copy =
		res.error.code in OAUTH_ERRORS
			? { message: oauthErrorCopy(res.error.code, res.error.message) }
			: describeError(res.error);
	renderError(errorBox, copy);
	announce(copy.message);
	return false;
}
