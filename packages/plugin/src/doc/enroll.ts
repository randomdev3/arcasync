import * as Y from "yjs";
import { applyText } from "./applyText";
import type { DiskWriter } from "./DiskWriter";
import { diskText, textHash } from "./diskText";

/** Transaction origin of the one-time insert of disk text into an empty note doc. */
export const ENROLL_ORIGIN = "teamsync:enroll";
/** Transaction origin of a disk edit of a closed note applied to its doc. */
export const DISK_ORIGIN = "teamsync:disk";

const META = "meta";
const ENROLLED = "enrolled";

export function isEnrolled(ydoc: Y.Doc): boolean {
	return ydoc.getMap(META).get(ENROLLED) === true;
}

/** 32-bit FNV-1a over UTF-16 code units. */
function fnv1a(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * The enrollment of `text` as a Yjs update that is byte-identical on every device: it is made by
 * a scratch doc whose client id derives from the text, holding only the insert and
 * `meta.enrolled = true`. Two devices that enroll the same file text concurrently therefore
 * produce the same structs (same client, same clocks), which Yjs merges as one, so the text
 * lands in the CRDT exactly once. Nothing device-specific may ever be added to this update.
 */
export function enrollmentUpdate(text: string): Uint8Array {
	const scratch = new Y.Doc();
	scratch.clientID = fnv1a(text);
	scratch.transact(() => {
		scratch.getText("contents").insert(0, text);
		scratch.getMap(META).set(ENROLLED, true);
	});
	const update = Y.encodeStateAsUpdate(scratch);
	scratch.destroy();
	return update;
}

export interface ReconcileInput {
	/** Normalised disk text; null when the file does not exist. */
	disk: string | null;
	doc: string;
	enrolled: boolean;
	diskHash: string | null;
	docHash: string;
	/** Hash of the text disk and doc last agreed on, on this device; undefined if never. */
	lastSyncedHash: string | undefined;
	/** Server state is loaded (provider synced) and this user may write. */
	canEnroll: boolean;
	/** This user may change the doc (not a viewer). */
	writable: boolean;
}

/**
 * - `missing`: no file; nothing to do (index sync owns creation).
 * - `defer`: the doc was never enrolled, is empty and the disk has text, but enrolling must wait
 *   for the server state. Never write the empty doc over the file.
 * - `enroll`: insert the disk text once.
 * - `in-sync`: disk and doc agree.
 * - `write-doc`: the disk holds nothing this device has not synced; the doc replaces it.
 * - `apply-disk`: the disk was edited while the doc stayed at the last synced text; the edit
 *   goes into the doc (a three-way merge whose base is the doc itself).
 * - `conflict`: both moved since they last agreed. The doc wins on disk and the disk text is
 *   kept in a local copy. Nothing is dropped.
 */
export type ReconcileAction =
	| "missing"
	| "defer"
	| "enroll"
	| "in-sync"
	| "write-doc"
	| "apply-disk"
	| "conflict";

export function decide(input: ReconcileInput): ReconcileAction {
	const { disk, doc, lastSyncedHash } = input;
	if (disk === null) return "missing";
	if (!input.enrolled && doc === "" && disk !== "") return input.canEnroll ? "enroll" : "defer";
	if (disk === doc) return "in-sync";
	// An empty file never empties a note: it is the shape of a fresh placeholder or a failed
	// write far more often than of a deliberate offline "delete everything".
	if (disk === "") return "write-doc";
	const diskTouched = input.diskHash !== lastSyncedHash;
	if (!diskTouched) return "write-doc";
	const docMoved = lastSyncedHash === undefined || input.docHash !== lastSyncedHash;
	if (!docMoved && input.writable) return "apply-disk";
	return "conflict";
}

/** What reconcile needs from a note; `NoteDoc` implements it. */
export interface ReconcileNote {
	readonly ydoc: Y.Doc;
	readonly ytext: Y.Text;
	readonly synced: boolean;
	readonly readonly: boolean;
	getLastSyncedHash(): Promise<string | undefined>;
	setLastSyncedHash(hash: string): Promise<void>;
}

export interface ReconcileDeps {
	writer: DiskWriter;
	/** Device label used in local-copy names. */
	device: string;
	now?: () => Date;
	/** Tells the user a local copy was saved. */
	notify?: (message: string) => void;
}

export interface ReconcileResult {
	action: ReconcileAction;
	/** Path of the local copy written for a conflict. */
	copy?: string;
	/** The disk changed underneath and the caller should reconcile again. */
	retry?: boolean;
}

/**
 * Brings one note's disk file and doc into agreement (see `decide`). Callers serialise calls per
 * note. Only `DiskWriter` touches the vault, always compare-and-swap against the raw content
 * read here, so an edit landing in between makes this return `retry` instead of losing it.
 */
export async function reconcileNote(
	note: ReconcileNote,
	path: string,
	deps: ReconcileDeps,
): Promise<ReconcileResult> {
	const raw = await deps.writer.read(path);
	const disk = raw === null ? null : diskText(raw);
	const doc = note.ytext.toString();
	const [diskHash, docHash, lastSyncedHash] = await Promise.all([
		disk === null ? null : textHash(disk),
		textHash(doc),
		note.getLastSyncedHash(),
	]);
	const action = decide({
		disk,
		doc,
		enrolled: isEnrolled(note.ydoc),
		diskHash,
		docHash,
		lastSyncedHash,
		canEnroll: note.synced && !note.readonly,
		writable: !note.readonly,
	});

	switch (action) {
		case "missing":
		case "defer":
			return { action };
		case "enroll":
			Y.applyUpdate(note.ydoc, enrollmentUpdate(disk as string), ENROLL_ORIGIN);
			// Another device may have enrolled different text first; the doc then holds both, and
			// the next reconcile writes that to disk (the disk text is inside it, nothing lost).
			await note.setLastSyncedHash(diskHash as string);
			return { action };
		case "in-sync":
			if (diskHash !== lastSyncedHash) await note.setLastSyncedHash(diskHash as string);
			return { action };
		case "apply-disk":
			applyText(note.ytext, disk as string, DISK_ORIGIN);
			await note.setLastSyncedHash(diskHash as string);
			return { action };
		case "write-doc": {
			const result = await deps.writer.write(path, doc, raw as string);
			if (result === "changed") return { action, retry: true };
			if (result === "missing") return { action: "missing" };
			await note.setLastSyncedHash(docHash);
			return { action };
		}
		case "conflict": {
			// The copy goes first: if it cannot be written, the disk text is not overwritten.
			const copy = await deps.writer.saveCopy(
				path,
				disk as string,
				deps.device,
				deps.now?.() ?? new Date(),
			);
			const result = await deps.writer.write(path, doc, raw as string);
			if (result === "changed") return { action, copy, retry: true };
			if (result !== "missing") await note.setLastSyncedHash(docHash);
			deps.notify?.(
				`TeamSync: ${path} changed here and on the server. The server version is kept; your version is saved as ${copy}.`,
			);
			return { action, copy };
		}
	}
}
