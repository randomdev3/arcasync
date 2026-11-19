import DiffMatchPatch from "diff-match-patch";
import { diskText } from "./diskText";

export type Merge3Result = { ok: true; text: string } | { ok: false };

const dmp = new DiffMatchPatch();
dmp.Match_Threshold = 0.1;
dmp.Patch_DeleteThreshold = 0.1;
// One character of context (grown until unique in the base, as always): with the default four,
// short lines next to each other share their context, and an edit of one line makes the patch
// for its neighbour miss the 0.1 threshold ("A\nB\nC\n" with A and C edited would not merge).
dmp.Patch_Margin = 1;
// How far a patch may land from where the base had it: the default (1000) with the 0.1
// threshold allows only about 100 characters, less than one side's insert of a paragraph above.
dmp.Match_Distance = 1_000_000;

/** `patches` applied to `text`, or null when any of them did not apply. */
function applyAll(patches: ReturnType<DiffMatchPatch["patch_make"]>, text: string): string | null {
	const [result, applied] = dmp.patch_apply(patches, text);
	return applied.every(Boolean) ? result : null;
}

/**
 * Three-way merge of two descendants of `base`. Each side's changes are patched onto the other
 * side, and the merge is accepted only when every patch applied both ways and both results are
 * the same text; anything else (overlapping or ambiguous edits) is `ok: false`, and the caller
 * keeps both versions instead.
 */
export function merge3(base: string, ours: string, theirs: string): Merge3Result {
	const b = diskText(base);
	const o = diskText(ours);
	const t = diskText(theirs);
	if (o === b || o === t) return { ok: true, text: t };
	if (t === b) return { ok: true, text: o };
	const oursOntoTheirs = applyAll(dmp.patch_make(b, o), t);
	if (oursOntoTheirs === null) return { ok: false };
	const theirsOntoOurs = applyAll(dmp.patch_make(b, t), o);
	if (theirsOntoOurs === null || theirsOntoOurs !== oursOntoTheirs) return { ok: false };
	return { ok: true, text: oursOntoTheirs };
}
