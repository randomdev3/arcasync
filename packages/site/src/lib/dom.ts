import { formatRemaining } from "./codes";
import type { ErrorCopy } from "./errors";

/** The element matching `selector`; a missing one is a markup bug, so it throws. */
export function $<T extends HTMLElement = HTMLElement>(
	selector: string,
	root: ParentNode = document,
): T {
	const el = root.querySelector<T>(selector);
	if (!el) throw new Error(`missing ${selector}`);
	return el;
}

export function show(el: HTMLElement, visible: boolean): void {
	el.hidden = !visible;
}

/** Shows the `[data-state]` section named `state` inside `root` and hides the others. */
export function showState(root: ParentNode, state: string): HTMLElement | null {
	let shown: HTMLElement | null = null;
	for (const section of root.querySelectorAll<HTMLElement>("[data-state]")) {
		const on = section.dataset.state === state;
		section.hidden = !on;
		if (on) shown = section;
	}
	return shown;
}

/** Busy button: `aria-busy`, disabled, and a "…ing" label; restores the label afterwards. */
export function setBusy(button: HTMLButtonElement, busy: boolean, busyLabel?: string): void {
	if (button.dataset.label === undefined) button.dataset.label = button.textContent ?? "";
	button.setAttribute("aria-busy", String(busy));
	button.disabled = busy;
	button.textContent = busy && busyLabel ? busyLabel : (button.dataset.label ?? "");
}

let statusRegion: HTMLElement | null = null;

/** Says `text` through the page's one polite live region (state changes only, never ticks). */
export function announce(text: string): void {
	statusRegion ??= document.querySelector<HTMLElement>("[data-status]");
	if (!statusRegion) return;
	statusRegion.textContent = "";
	// A fresh text node after clearing makes screen readers repeat an identical message.
	requestAnimationFrame(() => {
		if (statusRegion) statusRegion.textContent = text;
	});
}

/** Moves focus to a heading or error (made focusable) without scrolling past it. */
export function focus(el: HTMLElement | null): void {
	if (!el) return;
	if (!el.hasAttribute("tabindex") && !/^(INPUT|BUTTON|A|TEXTAREA|SELECT)$/.test(el.tagName)) {
		el.tabIndex = -1;
	}
	el.focus({ preventScroll: false });
}

/** Copy buttons: `[data-copy]` copies the text of the element its value names (by id). */
export function wireCopyButtons(root: ParentNode = document): void {
	for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
		if (button.dataset.copyWired) continue;
		button.dataset.copyWired = "1";
		button.addEventListener("click", async () => {
			const source = document.getElementById(button.dataset.copy ?? "");
			const text = source?.dataset.value ?? source?.textContent ?? "";
			const label = button.textContent;
			try {
				await navigator.clipboard.writeText(text.trim());
				button.textContent = "Copied";
				announce("Copied");
			} catch {
				button.textContent = "Select and copy";
			}
			window.setTimeout(() => {
				button.textContent = label;
			}, 2000);
		});
	}
}

/** Fills an error box: the message, then "(code)" in mono for codes without their own copy. */
export function renderError(box: HTMLElement, copy: ErrorCopy | null): void {
	box.hidden = copy === null;
	box.replaceChildren();
	if (!copy) return;
	const text = document.createElement("span");
	text.textContent = copy.message;
	box.append(text);
	if (copy.code) {
		const code = document.createElement("code");
		code.textContent = copy.code;
		box.append(" (", code, ")");
	}
}

/** Sets a user's colour dot (CSSOM, allowed by the CSP; never a `style` attribute). */
export function paintDot(dot: HTMLElement, color: string): void {
	dot.style.backgroundColor = color || "";
}

/** Updates `el` with "m:ss" until `until`, then calls `done`. Returns a stop function. */
export function countdown(el: HTMLElement, until: number, done?: () => void): () => void {
	const tick = () => {
		const left = until - Date.now();
		el.textContent = formatRemaining(left);
		if (left <= 0) {
			window.clearInterval(handle);
			done?.();
		}
	};
	const handle = window.setInterval(tick, 1000);
	tick();
	return () => window.clearInterval(handle);
}

/** A list of workspaces as name / role rows. */
export function renderWorkspaces(list: HTMLElement, rows: { name: string; role: string }[]): void {
	list.replaceChildren(
		...rows.map((row) => {
			const li = document.createElement("li");
			const name = document.createElement("span");
			name.textContent = row.name;
			const role = document.createElement("span");
			role.className = "badge";
			role.textContent = row.role;
			li.append(name, role);
			return li;
		}),
	);
}
