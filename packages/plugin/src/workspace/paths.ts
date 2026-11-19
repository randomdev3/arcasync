import { isIgnoredPath, kindForPath } from "@arcasync/shared";

/**
 * Two path spaces meet here. Vault paths are what Obsidian uses (`Shared/notes/a.md`). Workspace
 * paths are the index-doc keys, relative to the mapped folder (`notes/a.md`), so two vaults may map
 * the workspace under different folder names. `root` is a vault folder path without leading or
 * trailing slashes.
 */

/** A relative path that stays inside its base: no empty, `.` or `..` segments, nothing hidden. */
function isSafeRelative(path: string): boolean {
	if (path === "" || path.startsWith("/") || path.endsWith("/")) return false;
	const segs = path.split("/");
	if (segs.some((s) => s === "" || s === "." || s === "..")) return false;
	if (segs.some((s) => s === ".obsidian" || s === ".trash")) return false;
	return !isIgnoredPath(path);
}

/** True when `vaultPath` lies strictly inside the folder `root`. */
export function isUnder(root: string, vaultPath: string): boolean {
	return root !== "" && vaultPath.startsWith(`${root}/`) && vaultPath.length > root.length + 1;
}

/** True when one folder is the other or lies inside it (`a` and `a/b`, but not `a` and `ab`). */
export function foldersOverlap(a: string, b: string): boolean {
	return a === b || isUnder(a, b) || isUnder(b, a);
}

/** The item whose root folder contains `vaultPath`, or null (roots never overlap). */
export function containingRoot<T extends { root: string | null }>(
	items: Iterable<T>,
	vaultPath: string,
): T | null {
	for (const item of items) if (item.root !== null && isUnder(item.root, vaultPath)) return item;
	return null;
}

/** Workspace path for a vault path under `root`; null when outside it or not syncable. */
export function toWs(root: string, vaultPath: string): string | null {
	if (!isUnder(root, vaultPath)) return null;
	const rel = vaultPath.slice(root.length + 1);
	return isSafeRelative(rel) ? rel : null;
}

/** Vault path for a workspace path; null when the workspace path could escape `root`. */
export function toVault(root: string, wsPath: string): string | null {
	if (root === "" || !isSafeRelative(wsPath)) return null;
	return `${root}/${wsPath}`;
}

/**
 * How a workspace path syncs: `md` through a note doc, `binary` through R2 chunks (P2-11), or
 * null for kinds not synced yet (canvas, base, config, `.excalidraw.md`).
 */
export function syncKind(wsPath: string): "md" | "binary" | null {
	const kind = kindForPath(wsPath);
	return kind === "md" || kind === "binary" ? kind : null;
}

/** Workspace paths synced as notes: markdown only (`.excalidraw.md` is its own kind). */
export function isSyncedNote(wsPath: string): boolean {
	return syncKind(wsPath) === "md";
}
