import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

export interface CloneEntry {
	doc: string;
	update: Uint8Array;
}

export interface DecodedClone {
	entries: CloneEntry[];
	/** Requested docs that did not fit in this response (`CLONE_MAX_BYTES`); ask again for them. */
	remaining: string[];
}

/**
 * Bulk-clone response body: varUint count, then per entry varString doc + varUint8Array update,
 * then varUint remaining count + varStrings.
 */
export function encodeClone(entries: CloneEntry[], remaining: string[]): Uint8Array {
	const enc = encoding.createEncoder();
	encoding.writeVarUint(enc, entries.length);
	for (const e of entries) {
		encoding.writeVarString(enc, e.doc);
		encoding.writeVarUint8Array(enc, e.update);
	}
	encoding.writeVarUint(enc, remaining.length);
	for (const doc of remaining) encoding.writeVarString(enc, doc);
	return encoding.toUint8Array(enc);
}

export function decodeClone(bytes: Uint8Array): DecodedClone {
	const dec = decoding.createDecoder(bytes);
	const entries: CloneEntry[] = [];
	for (let n = decoding.readVarUint(dec); n > 0; n--) {
		const doc = decoding.readVarString(dec);
		entries.push({ doc, update: decoding.readVarUint8Array(dec) });
	}
	const remaining: string[] = [];
	for (let n = decoding.readVarUint(dec); n > 0; n--) remaining.push(decoding.readVarString(dec));
	if (decoding.hasContent(dec)) throw new Error("clone: trailing bytes");
	return { entries, remaining };
}
