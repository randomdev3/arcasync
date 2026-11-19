import { type DecodedClone, decodeClone } from "@teamsync/shared";
import { toApiError } from "./ApiClient";
import { bearerRequest, header, sleep, type WorkspaceAuth } from "./bearer";

/** A 429 is waited out and retried; this many requests at most. */
export const CLONE_ATTEMPTS = 3;

export interface CloneClientOptions {
	auth: WorkspaceAuth;
	workspaceId: string;
	sleep?: (ms: number) => Promise<void>;
}

/** One doc to clone; `sv` (its local state vector) asks for a diff instead of the full state. */
export interface CloneItem {
	doc: string;
	sv?: Uint8Array;
}

/** Bulk clone (`POST /api/workspaces/:id/docs`, D8): many docs' states in one request. */
export class CloneClient {
	private readonly wait: (ms: number) => Promise<void>;

	constructor(private readonly options: CloneClientOptions) {
		this.wait = options.sleep ?? sleep;
	}

	/** States (or diffs) of `items` in request order; `remaining` did not fit and is asked again. */
	async clone(items: CloneItem[]): Promise<DecodedClone> {
		const body = JSON.stringify({
			docs: items.map(({ doc, sv }) => (sv ? { doc, sv: toBase64(sv) } : { doc })),
		});
		for (let attempt = 1; ; attempt++) {
			const response = await bearerRequest(this.options.auth, {
				path: `/workspaces/${encodeURIComponent(this.options.workspaceId)}/docs`,
				method: "POST",
				contentType: "application/json",
				body,
			});
			if (response.status === 429 && attempt < CLONE_ATTEMPTS) {
				const seconds = Number(header(response, "retry-after"));
				await this.wait(Math.max(1, Number.isFinite(seconds) ? seconds : 1) * 1000);
				continue;
			}
			if (response.status >= 400) throw toApiError(response);
			return decodeClone(new Uint8Array(response.arrayBuffer));
		}
	}
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}
