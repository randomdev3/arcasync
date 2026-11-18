import DiffMatchPatch from "diff-match-patch";
import type * as Y from "yjs";

/** One replaced region: `old[oldStart, oldEnd)` becomes `new[newStart, newEnd)`. */
export interface TextOp {
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
}

const dmp = new DiffMatchPatch();

const isHigh = (s: string, i: number) => {
	const c = s.charCodeAt(i);
	return c >= 0xd800 && c <= 0xdbff;
};
const isLow = (s: string, i: number) => {
	const c = s.charCodeAt(i);
	return c >= 0xdc00 && c <= 0xdfff;
};
/** True when index `i` falls between the two halves of a surrogate pair. */
const splits = (s: string, i: number) => i > 0 && i < s.length && isHigh(s, i - 1) && isLow(s, i);

/**
 * The regions that differ between `oldText` and `newText`, never splitting a surrogate pair.
 * Y.Text replaces a split pair with U+FFFD, so boundaries are widened to whole code points.
 */
export function textOps(oldText: string, newText: string): TextOp[] {
	const ops: TextOp[] = [];
	let o = 0;
	let n = 0;
	let current: TextOp | null = null;
	for (const [kind, text] of dmp.diff_main(oldText, newText)) {
		if (kind === DiffMatchPatch.DIFF_EQUAL) {
			if (current) ops.push(current);
			current = null;
			o += text.length;
			n += text.length;
			continue;
		}
		current ??= { oldStart: o, oldEnd: o, newStart: n, newEnd: n };
		if (kind === DiffMatchPatch.DIFF_DELETE) o += text.length;
		else n += text.length;
		current.oldEnd = o;
		current.newEnd = n;
	}
	if (current) ops.push(current);

	const merged: TextOp[] = [];
	for (const op of ops) {
		// The text just outside an op is equal in both strings, so widening keeps it a replace of
		// identical code units by identical code units.
		while (splits(oldText, op.oldStart) || splits(newText, op.newStart)) {
			op.oldStart--;
			op.newStart--;
		}
		while (splits(oldText, op.oldEnd) || splits(newText, op.newEnd)) {
			op.oldEnd++;
			op.newEnd++;
		}
		const last = merged.at(-1);
		if (last && op.oldStart <= last.oldEnd) {
			last.oldEnd = Math.max(last.oldEnd, op.oldEnd);
			last.newEnd = Math.max(last.newEnd, op.newEnd);
		} else merged.push(op);
	}
	return merged;
}

/**
 * Turns `ytext` into `target` with the smallest insert/delete set diff-match-patch finds, in one
 * transaction tagged `origin`. Returns the number of replaced regions (0 when already equal).
 */
export function applyText(ytext: Y.Text, target: string, origin: unknown): number {
	const current = ytext.toString();
	if (current === target) return 0;
	const ops = textOps(current, target);
	const doc = ytext.doc;
	if (!doc) throw new Error("applyText: Y.Text is not attached to a doc");
	doc.transact(() => {
		// Back to front, so earlier offsets stay valid.
		for (let i = ops.length - 1; i >= 0; i--) {
			const op = ops[i] as TextOp;
			if (op.oldEnd > op.oldStart) ytext.delete(op.oldStart, op.oldEnd - op.oldStart);
			if (op.newEnd > op.newStart) ytext.insert(op.oldStart, target.slice(op.newStart, op.newEnd));
		}
	}, origin);
	return ops.length;
}
