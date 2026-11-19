import "../styles/main.css";
import "../styles/home.css";
import { initChrome } from "../lib/chrome";
import { $ } from "../lib/dom";
import { parseInvite } from "../lib/invite";
import { PENDING_INVITE_KEY } from "../lib/session";
import { THEME_EVENT } from "../lib/theme";

const app = initChrome();

// --- "I have an invite": a paste field that hands the token to /join ------------------------

const toggle = $<HTMLButtonElement>("[data-invite-toggle]");
const form = $<HTMLFormElement>("[data-invite-form]");
const input = $<HTMLInputElement>("#invite-input");
const error = $("#invite-error");

toggle.addEventListener("click", () => {
	const open = form.hidden;
	form.hidden = !open;
	toggle.setAttribute("aria-expanded", String(open));
	if (open) input.focus();
});

form.addEventListener("submit", (event) => {
	event.preventDefault();
	const parsed = parseInvite(input.value);
	const expected = parsed?.kind === "obsidian" ? app.relay : location.origin;
	const message = !parsed
		? "That doesn't look like an ArcaSync invite link."
		: parsed.server && parsed.server !== expected
			? `That invite is for another server (${parsed.server}). Open the link you were sent instead.`
			: null;
	error.hidden = !message;
	error.textContent = message ?? "";
	input.setAttribute("aria-invalid", String(Boolean(message)));
	if (!parsed || message) {
		input.focus();
		return;
	}
	// Session storage, not the URL: the token stays out of history and logs.
	app.pending.setItem(PENDING_INVITE_KEY, parsed.token);
	location.assign("/join");
});

// --- The display: the canvas takes over from the build-time still -----------------------------

const figure = $("[data-display]");
const screen = $("[data-display-screen]");
const canvas = $<HTMLCanvasElement>("[data-display-canvas]");
const statusLabel = $("[data-display-status]");
const onlineLabel = $("[data-display-online]");

const sentence = (text: string) => text.charAt(0) + text.slice(1).toLowerCase();

async function startDisplay() {
	const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
	if (connection?.saveData) return;
	const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
	try {
		const { createDisplay } = await import("../matrix/display");
		const display = createDisplay(screen, canvas, {
			reducedMotion: motion.matches,
			onStatus: (status, online) => {
				statusLabel.textContent = sentence(status);
				onlineLabel.textContent = String(online);
			},
		});
		if (!display) return;
		figure.classList.add("is-live");
		motion.addEventListener("change", (e) => display.setReducedMotion(e.matches));
		window.addEventListener(THEME_EVENT, () => {
			// Let the new custom properties apply before reading them.
			requestAnimationFrame(() => display.recolor());
		});
		(window as Window & { __display?: unknown }).__display = display;
	} catch {
		// The still frame stays.
	}
}

function whenIdle(fn: () => void) {
	if ("requestIdleCallback" in window) window.requestIdleCallback(fn, { timeout: 1500 });
	else setTimeout(fn, 200);
}

if (document.readyState === "complete") whenIdle(() => void startDisplay());
else window.addEventListener("load", () => whenIdle(() => void startDisplay()), { once: true });
