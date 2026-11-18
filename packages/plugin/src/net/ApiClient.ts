import {
	API_PREFIX,
	ApiError as ApiErrorSchema,
	type DeviceInfo,
	MeResponse,
	ServerInfo,
	SessionResponse,
	type WorkspaceSummary,
	WorkspacesResponse,
	WsTokenResponse,
} from "@teamsync/shared";
import { type RequestUrlResponse, requestUrl } from "obsidian";
import type { z } from "zod";

/** The server answered, but with an error status. */
export class ApiRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "ApiRequestError";
	}
}

/** The request never produced a usable response (DNS, TLS, offline, bad JSON). */
export class NetworkError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "NetworkError";
	}
}

/** `@teamsync/shared` exports these as schemas only; derive the types here. */
export type MeResult = z.infer<typeof MeResponse>;
export type WsTokenResult = z.infer<typeof WsTokenResponse>;

export interface ApiClientOptions {
	/** Read lazily so a settings change takes effect without rebuilding the client. */
	getBaseUrl(): string;
	getSessionToken(): string | null;
}

interface RequestOptions<T> {
	method?: string;
	body?: unknown;
	schema: z.ZodType<T>;
	auth?: boolean;
}

export class ApiClient {
	constructor(private readonly options: ApiClientOptions) {}

	get baseUrl(): string {
		return this.options.getBaseUrl().trim().replace(/\/+$/, "");
	}

	serverInfo(): Promise<ServerInfo> {
		return this.request("/server-info", { schema: ServerInfo, auth: false });
	}

	devLogin(name: string, device: DeviceInfo): Promise<SessionResponse> {
		return this.request("/auth/dev-login", {
			method: "POST",
			body: { name, device },
			schema: SessionResponse,
			auth: false,
		});
	}

	me(): Promise<MeResult> {
		return this.request("/auth/me", { schema: MeResponse });
	}

	wsToken(workspaceId: string): Promise<WsTokenResult> {
		return this.request("/auth/ws-token", {
			method: "POST",
			body: { workspaceId },
			schema: WsTokenResponse,
		});
	}

	async workspaces(): Promise<WorkspaceSummary[]> {
		const response = await this.request("/workspaces", { schema: WorkspacesResponse });
		return response.workspaces;
	}

	private async request<T>(pathname: string, options: RequestOptions<T>): Promise<T> {
		const url = `${this.baseUrl}${API_PREFIX}${pathname}`;
		const headers: Record<string, string> = { Accept: "application/json" };
		if (options.body !== undefined) headers["Content-Type"] = "application/json";
		if (options.auth !== false) {
			const token = this.options.getSessionToken();
			if (!token) throw new ApiRequestError(401, "no_session", "Not signed in to this server");
			headers.Authorization = `Bearer ${token}`;
		}

		let response: RequestUrlResponse;
		try {
			response = await requestUrl({
				url,
				method: options.method ?? "GET",
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				// Obsidian throws on 400+ by default, which loses the error body.
				throw: false,
			});
		} catch (error) {
			throw new NetworkError(`Cannot reach ${url}`, { cause: error });
		}

		if (response.status >= 400) throw this.toApiError(response);

		const parsed = options.schema.safeParse(this.readJson(response, url));
		if (!parsed.success) {
			throw new NetworkError(`Unexpected response from ${url}: ${parsed.error.message}`);
		}
		return parsed.data;
	}

	private readJson(response: RequestUrlResponse, url: string): unknown {
		try {
			return response.json;
		} catch (error) {
			throw new NetworkError(`Non-JSON response from ${url}`, { cause: error });
		}
	}

	private toApiError(response: RequestUrlResponse): ApiRequestError {
		let body: unknown;
		try {
			body = response.json;
		} catch {
			body = undefined;
		}
		const parsed = ApiErrorSchema.safeParse(body);
		if (parsed.success) {
			return new ApiRequestError(
				response.status,
				parsed.data.error.code,
				parsed.data.error.message,
				parsed.data.error.details,
			);
		}
		return new ApiRequestError(response.status, "http_error", `HTTP ${response.status}`);
	}
}
