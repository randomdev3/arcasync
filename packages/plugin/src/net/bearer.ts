import { API_PREFIX } from "@arcasync/shared";
import { type RequestUrlParam, type RequestUrlResponse, requestUrl } from "obsidian";
import { NetworkError } from "./ApiClient";

/**
 * Where and as whom chunk and clone requests go: the workspace WS-JWT, never the session token
 * (D6). `invalidate` drops the cached token so the next `token()` mints a new one.
 */
export interface WorkspaceAuth {
	baseUrl(): string;
	token(): Promise<string>;
	invalidate(): void;
}

export interface BearerRequest {
	/** Below `/api`, e.g. `/chunks/<sha>`. */
	path: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
}

/**
 * `requestUrl` with the workspace JWT as bearer; never throws on an HTTP status. A 401 (expired,
 * stale after a membership change, or revoked) mints a new token and retries once.
 */
export async function bearerRequest(
	auth: WorkspaceAuth,
	request: BearerRequest,
): Promise<RequestUrlResponse> {
	const url = `${auth.baseUrl().trim().replace(/\/+$/, "")}${API_PREFIX}${request.path}`;
	for (let attempt = 0; ; attempt++) {
		const param: RequestUrlParam = {
			url,
			method: request.method ?? "GET",
			headers: { Authorization: `Bearer ${await auth.token()}` },
			throw: false,
		};
		if (request.contentType) param.contentType = request.contentType;
		if (request.body !== undefined) param.body = request.body;
		let response: RequestUrlResponse;
		try {
			response = await requestUrl(param);
		} catch (error) {
			throw new NetworkError(`Cannot reach ${url}`, { cause: error });
		}
		if (response.status !== 401 || attempt > 0) return response;
		auth.invalidate();
	}
}

/** A response header, whatever its case. */
export function header(response: RequestUrlResponse, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(response.headers ?? {})) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
