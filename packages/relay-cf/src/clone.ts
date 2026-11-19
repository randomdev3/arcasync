/**
 * Bulk clone (D8), handled inside the workspace's DO: merged states (or diffs against the
 * client's state vectors) of up to `CLONE_MAX_DOCS` docs in one lib0-framed binary response,
 * capped at `CLONE_MAX_BYTES`. Reads only; no rows are written.
 */
import {
	CLONE_MAX_BYTES,
	type CloneEntry,
	type CloneRequest,
	encodeClone,
	parseDocName,
} from "@arcasync/shared";
import * as Y from "yjs";
import type { DocStore } from "./store";

const CLONE_BURST = 10;
const CLONE_REFILL_PER_MS = 30 / 60_000;

/** In-memory token bucket per user: capacity 10, refilled at 30 per minute. */
export class CloneRateLimiter {
	private readonly buckets = new Map<string, { tokens: number; at: number }>();

	constructor(
		private readonly capacity = CLONE_BURST,
		private readonly refillPerMs = CLONE_REFILL_PER_MS,
		private readonly now: () => number = Date.now,
	) {}

	/** 0 when the call may proceed, otherwise the seconds to wait (`Retry-After`). */
	take(uid: string): number {
		const now = this.now();
		const bucket = this.buckets.get(uid) ?? { tokens: this.capacity, at: now };
		const tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.at) * this.refillPerMs);
		if (tokens < 1) {
			this.buckets.set(uid, { tokens, at: now });
			return Math.max(1, Math.ceil((1 - tokens) / this.refillPerMs / 1000));
		}
		this.buckets.set(uid, { tokens: tokens - 1, at: now });
		return 0;
	}
}

function fromBase64(value: string): Uint8Array {
	const raw = atob(value);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

export type CloneResult =
	| { ok: true; body: Uint8Array; docs: number }
	| { ok: false; message: string };

/**
 * Docs in request order until the next one would push the body past `CLONE_MAX_BYTES` (the first
 * is always included); the rest come back in `remaining`. Every doc must be a non-index doc of
 * `workspaceId`, and every `sv` a valid base64 state vector.
 */
export function cloneDocs(
	store: Pick<DocStore, "state">,
	workspaceId: string,
	req: CloneRequest,
): CloneResult {
	const svs: (Uint8Array | null)[] = [];
	for (const { doc, sv } of req.docs) {
		const ref = parseDocName(doc);
		if (!ref || ref.workspaceId !== workspaceId || ref.kind === "index") {
			return { ok: false, message: `Not a clonable doc of this workspace: ${doc}` };
		}
		try {
			svs.push(sv === undefined ? null : fromBase64(sv));
		} catch {
			return { ok: false, message: `Invalid sv for ${doc}` };
		}
	}
	const entries: CloneEntry[] = [];
	let total = 0;
	let next = 0;
	for (; next < req.docs.length; next++) {
		const doc = (req.docs[next] as { doc: string }).doc;
		const sv = svs[next];
		const state = store.state(doc);
		let update: Uint8Array;
		try {
			update = sv ? Y.diffUpdate(state, sv) : state;
		} catch {
			return { ok: false, message: `Invalid sv for ${doc}` };
		}
		if (entries.length > 0 && total + update.length > CLONE_MAX_BYTES) break;
		entries.push({ doc, update });
		total += update.length;
	}
	const remaining = req.docs.slice(next).map((d) => d.doc);
	return { ok: true, body: encodeClone(entries, remaining), docs: entries.length };
}
