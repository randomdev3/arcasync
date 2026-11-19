import { THEME_KEY } from "./session";

export type ThemeMode = "system" | "light" | "dark";
export const THEME_EVENT = "arcasync:theme";

const ORDER: ThemeMode[] = ["system", "light", "dark"];
const LABEL: Record<ThemeMode, string> = { system: "Auto", light: "Light", dark: "Dark" };

function stored(): ThemeMode {
	try {
		const value = localStorage.getItem(THEME_KEY);
		return value === "light" || value === "dark" ? value : "system";
	} catch {
		return "system";
	}
}

function apply(mode: ThemeMode): void {
	const root = document.documentElement;
	if (mode === "system") delete root.dataset.theme;
	else root.dataset.theme = mode;
	try {
		if (mode === "system") localStorage.removeItem(THEME_KEY);
		else localStorage.setItem(THEME_KEY, mode);
	} catch {}
}

/** The header toggle: cycles System, Light, Dark; `public/theme.js` applied it before paint. */
export function initThemeToggle(): void {
	const button = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
	if (!button) return;
	let mode = stored();
	const render = () => {
		const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length] ?? "system";
		button.dataset.mode = mode;
		button.setAttribute(
			"aria-label",
			`Colour theme: ${LABEL[mode].toLowerCase()}. Switch to ${LABEL[next].toLowerCase()}.`,
		);
		const label = button.querySelector("[data-theme-label]");
		if (label) label.textContent = LABEL[mode];
	};
	render();
	button.addEventListener("click", () => {
		mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length] ?? "system";
		apply(mode);
		render();
		window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: mode }));
	});
	// "Auto" follows the system live; tell listeners (the display) when it flips.
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		if (mode === "system") window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: mode }));
	});
}
