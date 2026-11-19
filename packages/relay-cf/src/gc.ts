/**
 * Chunk GC (D13), pure over an injected bucket so it unit-tests without R2. An object is deleted
 * only when it is older than the grace period and referenced in neither of two projections, one
 * taken before the listing and one after it.
 */

export interface GcObject {
	key: string;
	uploaded: Date;
}

/** The subset of `R2Bucket` GC uses. */
export interface GcBucket {
	list(options: {
		prefix: string;
		cursor?: string;
		limit?: number;
	}): Promise<{ objects: GcObject[]; truncated: boolean; cursor?: string }>;
	delete(keys: string[]): Promise<void>;
}

export interface ChunkGcOptions {
	bucket: GcBucket;
	/** `ws/<workspaceId>/`; object keys are the prefix plus the chunk sha. */
	prefix: string;
	/** Chunk shas the workspace references now (projects the index first). */
	project: () => Set<string> | Promise<Set<string>>;
	now: number;
	graceMs: number;
	/** Listing pages per run (D17: ≤ 20 list calls, so ≤ 20 delete batches). */
	maxPages?: number;
	pageSize?: number;
	/** Called once when the listing was capped, to continue the run later. */
	rearm?: (at: number) => void | Promise<void>;
}

export interface ChunkGcResult {
	listed: number;
	deleted: number;
	kept: number;
	capped: boolean;
}

export const GC_MAX_PAGES = 20;
const GC_PAGE_SIZE = 1000;
/** R2 deletes at most 1000 keys per call. */
const GC_DELETE_BATCH = 1000;
/** A capped run continues an hour later. */
export const GC_CAPPED_RETRY_MS = 3_600_000;

export async function runChunkGc(options: ChunkGcOptions): Promise<ChunkGcResult> {
	const { bucket, prefix, now, graceMs } = options;
	const maxPages = options.maxPages ?? GC_MAX_PAGES;
	const pageSize = options.pageSize ?? GC_PAGE_SIZE;

	const refsA = await options.project();
	const objects: GcObject[] = [];
	let cursor: string | undefined;
	let capped = true;
	for (let page = 0; page < maxPages; page++) {
		const res = await bucket.list({ prefix, cursor, limit: pageSize });
		objects.push(...res.objects);
		if (!res.truncated) {
			capped = false;
			break;
		}
		cursor = res.cursor;
	}
	const refsB = await options.project();

	const cutoff = now - graceMs;
	const doomed = objects
		.filter((o) => {
			const sha = o.key.slice(prefix.length);
			return o.uploaded.getTime() < cutoff && !refsA.has(sha) && !refsB.has(sha);
		})
		.map((o) => o.key);
	for (let i = 0; i < doomed.length; i += GC_DELETE_BATCH) {
		await bucket.delete(doomed.slice(i, i + GC_DELETE_BATCH));
	}
	if (capped) await options.rearm?.(now + GC_CAPPED_RETRY_MS);
	return {
		listed: objects.length,
		deleted: doomed.length,
		kept: objects.length - doomed.length,
		capped,
	};
}
