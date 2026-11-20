import { setIcon } from "obsidian";

/** `use:icon={"users"}`: renders an Obsidian (Lucide) icon into the element. */
export function icon(el: HTMLElement, name: string) {
	setIcon(el, name);
	return {
		update(next: string) {
			el.empty();
			setIcon(el, next);
		},
	};
}
