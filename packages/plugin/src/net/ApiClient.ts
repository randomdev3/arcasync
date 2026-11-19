import {
	API_PREFIX,
	ApiError as ApiErrorSchema,
	DeviceCodeResponse,
	type DeviceInfo,
	DeviceLookupResponse,
	InviteCreated,
	type InviteCreateRequest,
	type InviteSummary,
	InvitesResponse,
	type Member,
	MembersResponse,
	MeResponse,
	type Role,
	ServerInfo,
	SessionResponse,
	type WorkspaceSummary,
	WorkspacesResponse,
	WsTokenResponse,
} from "@teamsync/shared";
import { type RequestUrlResponse, requestUrl } from "obsidian";
import { z } from "zod";

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

/** The relay's body for a mutation without a result. */
const OkResponse = z.object({ ok: z.literal(true) });

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
	/** Requests sent per API pathname (no query string); e2e reads the device-code poll count. */
	readonly requestCounts: Record<string, number> = {};

	constructor(private readonly options: ApiClientOptions) {}

	get baseUrl(): string {
		return this.options.getBaseUrl().trim().replace(/\/+$/, "");
	}

	serverInfo(): Promise<ServerInfo> {
		return this.request("/server-info", { schema: ServerInfo, auth: false });
	}

	/**
	 * `role` applies only when the server creates a new membership for this user. `workspace`
	 * (a slug) joins or creates that workspace instead of the default dev one (relay-cf only).
	 */
	devLogin(
		name: string,
		device: DeviceInfo,
		role?: Role,
		workspace?: string,
	): Promise<SessionResponse> {
		return this.request("/auth/dev-login", {
			method: "POST",
			body: { name, device, role, workspace },
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

	/** Revokes this device's session on the server. */
	async logout(): Promise<void> {
		await this.request("/auth/logout", { method: "POST", schema: OkResponse });
	}

	/** Signed out: joins through an invite as a new user named `name`. */
	acceptInvite(token: string, name: string, device: DeviceInfo): Promise<SessionResponse> {
		return this.request("/auth/invite/accept", {
			method: "POST",
			body: { token, name, device },
			schema: SessionResponse,
			auth: false,
		});
	}

	/** Signed in: joins the invite's workspace; returns every workspace of this account. */
	async redeemInvite(token: string): Promise<WorkspaceSummary[]> {
		const response = await this.request("/invites/redeem", {
			method: "POST",
			body: { token },
			schema: WorkspacesResponse,
		});
		return response.workspaces;
	}

	/** Members of a workspace with their roles (any member may list). */
	async members(workspaceId: string): Promise<Member[]> {
		const response = await this.request(`/workspaces/${encodeURIComponent(workspaceId)}/members`, {
			schema: MembersResponse,
		});
		return response.members;
	}

	/** Owner or admin; a demoted or promoted member's sockets are closed with 4401. */
	async setRole(workspaceId: string, userId: string, role: Role): Promise<void> {
		await this.request(
			`/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
			{ method: "PATCH", body: { role }, schema: OkResponse },
		);
	}

	/** Owner or admin, or the member themselves; rejects with `last_owner` for the last owner. */
	async removeMember(workspaceId: string, userId: string): Promise<void> {
		await this.request(
			`/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
			{ method: "DELETE", schema: OkResponse },
		);
	}

	/** Owner or admin; the result's `url` is the only time the token is shown. */
	createInvite(
		workspaceId: string,
		invite: { role: Role } & Partial<Omit<InviteCreateRequest, "role">>,
	): Promise<InviteCreated> {
		return this.request(`/workspaces/${encodeURIComponent(workspaceId)}/invites`, {
			method: "POST",
			body: invite,
			schema: InviteCreated,
		});
	}

	async listInvites(workspaceId: string): Promise<InviteSummary[]> {
		const response = await this.request(`/workspaces/${encodeURIComponent(workspaceId)}/invites`, {
			schema: InvitesResponse,
		});
		return response.invites;
	}

	async revokeInvite(workspaceId: string, inviteId: string): Promise<void> {
		await this.request(
			`/workspaces/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(inviteId)}`,
			{ method: "DELETE", schema: OkResponse },
		);
	}

	/** Signed out: asks for a code that a signed-in device approves. */
	deviceStart(device: DeviceInfo): Promise<DeviceCodeResponse> {
		return this.request("/auth/device/start", {
			method: "POST",
			body: { device },
			schema: DeviceCodeResponse,
			auth: false,
		});
	}

	/** The session once approved; otherwise rejects with `authorization_pending`, `slow_down`, …. */
	devicePoll(deviceCode: string): Promise<SessionResponse> {
		return this.request("/auth/device/poll", {
			method: "POST",
			body: { deviceCode },
			schema: SessionResponse,
			auth: false,
		});
	}

	/** Which device asks for `userCode` (rate-limited by the server to 5 per minute). */
	deviceLookup(userCode: string): Promise<DeviceLookupResponse> {
		return this.request(`/auth/device/lookup?userCode=${encodeURIComponent(userCode)}`, {
			schema: DeviceLookupResponse,
		});
	}

	/** Approves (the device signs in as this user) or denies `userCode`. */
	async deviceApprove(userCode: string, approve: boolean): Promise<void> {
		await this.request("/auth/device/approve", {
			method: "POST",
			body: { userCode, approve },
			schema: OkResponse,
		});
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

		const counted = pathname.split("?")[0] ?? pathname;
		this.requestCounts[counted] = (this.requestCounts[counted] ?? 0) + 1;
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
