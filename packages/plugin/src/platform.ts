import { Platform } from "obsidian";

export interface PlatformLimits {
	/** Released note docs kept attached (LRU) before they are detached. */
	warmDocs: number;
	/** Closed notes BackgroundSync brings up to date at once. */
	bgConcurrency: number;
	/** Larger notes are not synced. */
	maxMdBytes: number;
}

export function limits(): PlatformLimits {
	return Platform.isMobile
		? { warmDocs: 5, bgConcurrency: 1, maxMdBytes: 2 * 1024 * 1024 }
		: { warmDocs: 20, bgConcurrency: 3, maxMdBytes: Number.POSITIVE_INFINITY };
}
