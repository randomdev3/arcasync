import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView, type PluginValue, ViewPlugin } from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

/** How long a remote caret's name label stays visible after the caret moves. */
export const RECENT_LABEL_MS = 2000;
/** On `.cm-ySelectionCaret` while its label shows without hover (styles.css). */
export const RECENT_CLASS = "is-recent";
/** On the editor until the note doc is ready; styles.css hides remote carets and selections. */
export const PENDING_CLASS = "arcasync-carets-pending";

/** A remote caret as y-codemirror.next draws it: its label text and its colour. */
export interface CaretIdentity {
	name: string;
	color: string;
}

/** Reads the identity y-codemirror.next renders for an awareness state, with its defaults. */
export function caretIdentity(state: unknown): CaretIdentity {
	const user = (state as { user?: { name?: unknown; color?: unknown } } | null)?.user;
	return {
		name: typeof user?.name === "string" ? user.name : "Anonymous",
		color: typeof user?.color === "string" ? user.color : "#30bced",
	};
}

/**
 * Which remote carets moved within the last `RECENT_LABEL_MS`: a peer's published cursor changed,
 * or a remote transaction carried that peer's edits (typing keeps the relative cursor unchanged,
 * so no awareness update is sent for it). Read-only on awareness: it never publishes anything.
 */
export class CaretRecency {
	private readonly until = new Map<number, number>();
	private readonly cursors = new Map<number, string>();
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly awareness: Awareness,
		private readonly onChange: () => void,
		private readonly now: () => number = Date.now,
	) {
		awareness.on("change", this.onAwareness);
		awareness.doc.on("afterTransaction", this.onTransaction);
	}

	/** Identities of the remote carets that moved recently. */
	recent(): CaretIdentity[] {
		const states = this.awareness.getStates();
		const out: CaretIdentity[] = [];
		for (const id of this.until.keys()) {
			const state = states.get(id);
			if (state) out.push(caretIdentity(state));
		}
		return out;
	}

	destroy(): void {
		this.awareness.off("change", this.onAwareness);
		this.awareness.doc.off("afterTransaction", this.onTransaction);
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.until.clear();
		this.cursors.clear();
	}

	private readonly onAwareness = (changes: {
		added: number[];
		updated: number[];
		removed: number[];
	}) => {
		let changed = false;
		for (const id of [...changes.added, ...changes.updated]) {
			if (id === this.awareness.clientID) continue;
			const cursor = this.awareness.getStates().get(id)?.cursor ?? null;
			const key = JSON.stringify(cursor);
			if (this.cursors.get(id) === key) continue;
			this.cursors.set(id, key);
			if (cursor !== null) changed = this.mark(id) || changed;
		}
		for (const id of changes.removed) {
			this.cursors.delete(id);
			changed = this.until.delete(id) || changed;
		}
		if (changed) this.onChange();
	};

	private readonly onTransaction = (tr: Y.Transaction) => {
		if (tr.local) return;
		let changed = false;
		for (const [client, clock] of tr.afterState) {
			if (client === this.awareness.clientID) continue;
			if (clock > (tr.beforeState.get(client) ?? 0)) changed = this.mark(client) || changed;
		}
		if (changed) this.onChange();
	};

	/** Returns true when the set of recent carets changed (not merely extended). */
	private mark(id: number): boolean {
		const fresh = !this.until.has(id);
		this.until.set(id, this.now() + RECENT_LABEL_MS);
		this.arm();
		return fresh;
	}

	private arm(): void {
		if (this.timer || this.until.size === 0) return;
		const next = Math.min(...this.until.values());
		this.timer = setTimeout(this.expire, Math.max(0, next - this.now()));
	}

	private readonly expire = () => {
		this.timer = null;
		const now = this.now();
		let changed = false;
		for (const [id, until] of this.until) {
			if (until <= now) changed = this.until.delete(id) || changed;
		}
		this.arm();
		if (changed) this.onChange();
	};
}

/** Toggles `RECENT_CLASS` on every `.cm-ySelectionCaret` under `root` whose identity is recent. */
export function stampCarets(root: ParentNode, recent: CaretIdentity[]): void {
	for (const el of root.querySelectorAll<HTMLElement>(".cm-ySelectionCaret")) {
		const name = el.querySelector(".cm-ySelectionInfo")?.textContent ?? "";
		// The inline style keeps the colour as y-codemirror.next wrote it (`el.style` normalises it).
		const style = el.getAttribute("style") ?? "";
		const on = recent.some((r) => r.name === name && style.includes(r.color));
		el.classList.toggle(RECENT_CLASS, on);
	}
}

export interface CaretLabelsConfig {
	/** The note doc's awareness, the same one given to `yCollab`. */
	awareness: Awareness;
	/** The note doc's `whenReady()`; remote carets stay hidden until it resolves. */
	ready: Promise<void>;
}

class CaretLabelsView implements PluginValue {
	private readonly recency: CaretRecency;
	private destroyed = false;

	constructor(
		private readonly view: EditorView,
		config: CaretLabelsConfig,
		readyEffect: StateEffect<null>,
	) {
		this.recency = new CaretRecency(config.awareness, () => this.schedule());
		config.ready.then(
			() => {
				if (!this.destroyed) this.view.dispatch({ effects: readyEffect });
			},
			() => undefined,
		);
	}

	update(): void {
		// Decorations may have recreated the caret DOM; re-stamp after the DOM update.
		this.schedule();
	}

	destroy(): void {
		this.destroyed = true;
		this.recency.destroy();
	}

	private schedule(): void {
		if (this.destroyed) return;
		this.view.requestMeasure({
			key: this,
			read: () => null,
			write: () => {
				if (!this.destroyed) stampCarets(this.view.contentDOM, this.recency.recent());
			},
		});
	}
}

/**
 * Companion to y-codemirror.next's remote selections, added next to `yCollab` in the binding's
 * compartment: shows a caret's name label for `RECENT_LABEL_MS` after it moves (hover shows it
 * too, via styles.css) and hides remote carets until the note doc is ready.
 */
export function caretLabels(config: CaretLabelsConfig): Extension {
	// Per call, so every bind (including a rebind in the same compartment) starts pending.
	const ready = StateEffect.define<null>();
	const pending = StateField.define<boolean>({
		create: () => true,
		update: (value, tr) => value && !tr.effects.some((e) => e.is(ready)),
		provide: (field) =>
			EditorView.editorAttributes.from(
				field,
				(on): Record<string, string> => (on ? { class: PENDING_CLASS } : {}),
			),
	});
	return [pending, ViewPlugin.define((view) => new CaretLabelsView(view, config, ready.of(null)))];
}
