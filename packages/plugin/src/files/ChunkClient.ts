import { CHUNKS_MISSING_MAX, ChunksMissingResponse, sha256Hex } from "@teamsync/shared";
import type { RequestUrlResponse } from "obsidian";
import { toApiError } from "../net/ApiClient";
import { bearerRequest, header, sleep, type WorkspaceAuth } from "../net/bearer";

/** `GET /api/chunks/:sha` answered 404: not uploaded yet, or collected. */
export class ChunkNotFoundError extends Error {
	constructor(readonly sha: string) {
		super(`chunk ${sha} not found`);
		this.name = "ChunkNotFoundError";
	}
}

/** Waits before each retry of a 5xx or 429 response. */
export const CHUNK_BACKOFF_MS = [1000, 2000, 4000] as const;
const CONCURRENCY = 2;

export interface ChunkClientOptions {
	auth: WorkspaceAuth;
	/** Requests in flight at once. */
	concurrency?: number;
	backoffMs?: readonly number[];
	sleep?: (ms: number) => Promise<void>;
}

/** R2 chunk transfers (P2-4 routes), at most `concurrency` requests at a time. */
export class ChunkClient {
	private readonly auth: WorkspaceAuth;
	private readonly backoffMs: readonly number[];
	private readonly wait: (ms: number) => Promise<void>;
	private readonly concurrency: number;
	private active = 0;
	private readonly waiting: Array<() => void> = [];

	constructor(options: ChunkClientOptions) {
		this.auth = options.auth;
		this.concurrency = options.concurrency ?? CONCURRENCY;
		this.backoffMs = options.backoffMs ?? CHUNK_BACKOFF_MS;
		this.wait = options.sleep ?? sleep;
	}

	/** The shas the relay does not have, in `CHUNKS_MISSING_MAX` batches. */
	async missing(shas: string[]): Promise<string[]> {
		const unique = [...new Set(shas)];
		const batches: string[][] = [];
		for (let i = 0; i < unique.length; i += CHUNKS_MISSING_MAX) {
			batches.push(unique.slice(i, i + CHUNKS_MISSING_MAX));
		}
		const results = await Promise.all(
			batches.map(async (batch) => {
				const response = await this.send({
					path: "/chunks/missing",
					method: "POST",
					contentType: "application/json",
					body: JSON.stringify({ shas: batch }),
				});
				const parsed = ChunksMissingResponse.safeParse(response.json);
				if (!parsed.success) throw new Error("unexpected /chunks/missing response");
				return parsed.data.missing;
			}),
		);
		return results.flat();
	}

	/** Uploads one chunk. A chunk that already existed (`created: false`) is a success too. */
	async put(sha: string, bytes: Uint8Array): Promise<void> {
		const body =
			bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
				? (bytes.buffer as ArrayBuffer)
				: (bytes.slice().buffer as ArrayBuffer);
		await this.send({
			path: `/chunks/${sha}`,
			method: "PUT",
			contentType: "application/octet-stream",
			body,
		});
	}

	/** Downloads one chunk and checks its sha256; a mismatch is fetched once more, then fails. */
	async get(sha: string): Promise<Uint8Array> {
		for (let attempt = 0; ; attempt++) {
			const response = await this.send({ path: `/chunks/${sha}` }, sha);
			const bytes = new Uint8Array(response.arrayBuffer);
			if ((await sha256Hex(bytes)) === sha) return bytes;
			if (attempt > 0) throw new Error(`chunk ${sha}: content does not match its sha256`);
		}
	}

	/** One request in a concurrency slot; 5xx and 429 are retried with backoff. */
	private async send(
		request: Parameters<typeof bearerRequest>[1],
		notFound?: string,
	): Promise<RequestUrlResponse> {
		await this.acquire();
		try {
			for (let attempt = 0; ; attempt++) {
				const response = await bearerRequest(this.auth, request);
				if (response.status < 400) return response;
				if (response.status === 404 && notFound) throw new ChunkNotFoundError(notFound);
				const delay = this.backoffMs[attempt];
				const retriable = response.status >= 500 || response.status === 429;
				if (!retriable || delay === undefined) throw toApiError(response);
				const retryAfter = Number(header(response, "retry-after")) * 1000;
				await this.wait(Number.isFinite(retryAfter) ? Math.max(delay, retryAfter) : delay);
			}
		} finally {
			this.release();
		}
	}

	private acquire(): Promise<void> {
		if (this.active < this.concurrency) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.waiting.push(resolve));
	}

	private release(): void {
		const next = this.waiting.shift();
		if (next) next();
		else this.active--;
	}
}
