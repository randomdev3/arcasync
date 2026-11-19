// Editor, input and disk helpers for e2e scenarios. Every helper takes a VaultHandle (obsidian.mjs)
// and acts on its active editor. Keys go through CDP `Input.dispatchKeyEvent`, so the page sees
// real keydown/beforeinput/input events.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { PNG } from "pngjs";
import { ROOT, sleep, waitFor } from "./obsidian.mjs";

export const ARTIFACTS = join(ROOT, ".e2e", "artifacts");

const EDITOR = `
	const editor = app.workspace.activeEditor?.editor;
	if (!editor) throw new Error("no active editor");
	const cm = editor.cm;
`;

/** Opens `path` in the current leaf, or in a new split with `{split: true}`, and focuses it. */
export function openFile(v, path, { split = false } = {}) {
	return v.eval(
		`
		const file = app.vault.getAbstractFileByPath(args.path);
		if (!file) throw new Error("no such file: " + args.path);
		const leaf = app.workspace.getLeaf(args.split ? "split" : false);
		await leaf.openFile(file, { active: true });
		app.workspace.setActiveLeaf(leaf, { focus: true });
		return true;
	`,
		{ path, split },
	);
}

export function activeFile(v) {
	return v.eval("return app.workspace.getActiveFile()?.path ?? null;");
}

export function editorText(v) {
	return v.eval("return app.workspace.activeEditor?.editor?.getValue() ?? null;");
}

/** Places the caret at `{line, ch}` (0-based, Obsidian's Editor convention) and focuses the editor. */
export function setCursor(v, pos) {
	return v.eval(`${EDITOR} editor.setCursor(args.pos); cm.focus(); return true;`, { pos });
}

export function selectRange(v, from, to) {
	return v.eval(`${EDITOR} editor.setSelection(args.from, args.to); cm.focus(); return true;`, {
		from,
		to,
	});
}

/** Inserts `text` at `pos` (default: the cursor) through the Editor API; fires no key events. */
export function replaceRange(v, text, pos) {
	return v.eval(
		`${EDITOR} editor.replaceRange(args.text, args.pos ?? editor.getCursor()); return true;`,
		{ text, pos },
	);
}

const NAMED_KEYS = {
	Enter: { code: "Enter", keyCode: 13, text: "\r" },
	Tab: { code: "Tab", keyCode: 9, text: "\t" },
	Backspace: { code: "Backspace", keyCode: 8 },
	Delete: { code: "Delete", keyCode: 46 },
	Escape: { code: "Escape", keyCode: 27 },
	Home: { code: "Home", keyCode: 36 },
	End: { code: "End", keyCode: 35 },
	ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
	ArrowUp: { code: "ArrowUp", keyCode: 38 },
	ArrowRight: { code: "ArrowRight", keyCode: 39 },
	ArrowDown: { code: "ArrowDown", keyCode: 40 },
};

function keyDefinition(key) {
	if (NAMED_KEYS[key]) return { key, ...NAMED_KEYS[key] };
	if (key === " ") return { key, code: "Space", keyCode: 32, text: " " };
	if (/^[a-z]$/i.test(key)) {
		const upper = key.toUpperCase();
		return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
	}
	if (/^[0-9]$/.test(key))
		return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
	return { key, code: "", keyCode: 0, text: key };
}

async function dispatchKey(v, def, modifiers) {
	// With a modifier other than Shift the key is a shortcut and must not insert text.
	const text = modifiers & ~8 ? undefined : def.text;
	const common = {
		key: def.key,
		code: def.code,
		windowsVirtualKeyCode: def.keyCode,
		nativeVirtualKeyCode: def.keyCode,
		modifiers,
	};
	await v.cdp("Input.dispatchKeyEvent", {
		type: text ? "keyDown" : "rawKeyDown",
		...common,
		text,
		unmodifiedText: text,
	});
	await v.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

/**
 * Types `text` into the focused element one key at a time (keyDown + keyUp per character, `\n` is
 * Enter) at `cps` characters per second. The pacing runs in Node, so background-window timer
 * throttling cannot change it.
 */
export async function typeKeys(v, text, { cps = 10 } = {}) {
	const gap = 1000 / cps;
	for (const ch of text) {
		const started = Date.now();
		await dispatchKey(v, keyDefinition(ch === "\n" ? "Enter" : ch), 0);
		await sleep(Math.max(0, gap - (Date.now() - started)));
	}
}

/** Presses one key (a character or a name such as "Enter", "Backspace", "ArrowLeft") with modifiers. */
export function pressKey(v, key, { meta = false, ctrl = false, alt = false, shift = false } = {}) {
	const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
	return dispatchKey(v, keyDefinition(key), modifiers);
}

/** Reads a vault file from disk; null when it does not exist. */
export function diskText(vaultPath, rel) {
	try {
		return readFileSync(join(vaultPath, rel), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

/** Waits until the active editor's text equals `expected` (a string) or satisfies it (a function). */
export function waitEditorText(v, expected, { timeout = 5000 } = {}) {
	const ok = typeof expected === "function" ? expected : (t) => t === expected;
	return waitFor(
		async () => {
			const text = await editorText(v);
			return ok(text) ? { text } : null;
		},
		{ timeout, label: `${v.name} editor text ${JSON.stringify(String(expected))}` },
	).then((r) => r.text);
}

/** Remote carets rendered by y-codemirror.next: `[{name, color, rect}]`. */
export function carets(v) {
	return v.eval(`
		return [...document.querySelectorAll(".cm-ySelectionCaret")].map((el) => {
			const r = el.getBoundingClientRect();
			return {
				name: el.querySelector(".cm-ySelectionInfo")?.textContent ?? null,
				color: el.style.borderColor,
				rect: { x: r.x, y: r.y, width: r.width, height: r.height },
			};
		});
	`);
}

/** True when 0-based `line` of the active editor is rendered inside its scroll viewport. */
export function isLineVisible(v, line) {
	return v.eval(
		`${EDITOR}
		if (args.line >= cm.state.doc.lines) return false;
		const c = cm.coordsAtPos(cm.state.doc.line(args.line + 1).from);
		const r = cm.scrollDOM.getBoundingClientRect();
		return !!c && c.top >= r.top && c.bottom <= r.bottom;
	`,
		{ line },
	);
}

/**
 * Saves a PNG of the window (or of `clip` = {x, y, width, height} in CSS px) and returns its path.
 * A relative `file` lands under `.e2e/artifacts/`.
 */
export async function screenshot(v, file, clip) {
	const out = isAbsolute(file) ? file : join(ARTIFACTS, file);
	const { data } = await v.cdp("Page.captureScreenshot", {
		format: "png",
		...(clip ? { clip: { ...clip, scale: 1 } } : {}),
	});
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, Buffer.from(data, "base64"));
	return out;
}

/** Decodes a PNG file into `{width, height, data}` (RGBA bytes) for pixel checks. */
export function readPng(file) {
	return PNG.sync.read(readFileSync(file));
}

export function notices(v) {
	return v.eval('return [...document.querySelectorAll(".notice")].map((n) => n.textContent);');
}

/**
 * Runs `body` in vault `v` with \`root\` = the TeamSync modal that contains \`args.selector\`;
 * null while there is none. Modals are found through the plugin (`modals`), since Obsidian may
 * open one in another window's document.
 */
export function inModal(v, selector, body, args = {}) {
	return v.eval(
		`const modal = [...app.plugins.plugins.teamsync.modals].find((m) =>
			m.modalEl.querySelector(args.selector));
		if (!modal) return null;
		const root = modal.modalEl;
		${body}`,
		{ ...args, selector },
	);
}

/** The text of the open modal's element matching `selector`, or null while absent. */
export function modalText(v, selector) {
	return inModal(v, selector, "return root.querySelector(args.selector).textContent.trim();");
}
