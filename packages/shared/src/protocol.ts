import { z } from "zod";
import { CHUNKS_MISSING_MAX, CLONE_MAX_DOCS, INVITE_DEFAULT_TTL_S } from "./constants.js";
import { FileKind } from "./fileKinds.js";

export const Role = z.enum(["owner", "editor", "viewer"]);
export type Role = z.infer<typeof Role>;

export const User = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string().nullable(),
	color: z.string(),
	avatarUrl: z.string().nullable(),
	isAdmin: z.boolean(),
});
export type User = z.infer<typeof User>;

export const DeviceInfo = z.object({
	name: z.string().min(1).max(100),
	platform: z.enum(["macos", "windows", "linux", "ios", "android", "unknown"]),
	vaultId: z.string().min(1).max(100),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const WorkspaceSummary = z.object({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	role: Role,
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const SessionResponse = z.object({
	sessionToken: z.string(),
	user: User,
	workspaces: z.array(WorkspaceSummary),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const WorkspacesResponse = z.object({ workspaces: z.array(WorkspaceSummary) });
export type WorkspacesResponse = z.infer<typeof WorkspacesResponse>;

export const DevLoginRequest = z.object({
	name: z.string().min(1).max(60),
	device: DeviceInfo,
	role: Role.optional(),
	/** Dev-only: join or create this workspace slug instead of `dev`. */
	workspace: z
		.string()
		.regex(/^[a-z0-9-]{1,40}$/)
		.optional(),
});
export type DevLoginRequest = z.infer<typeof DevLoginRequest>;

export const BootstrapRequest = z.object({ workspaceName: z.string().min(1).max(60) });
export type BootstrapRequest = z.infer<typeof BootstrapRequest>;

export const InviteCreated = z.object({
	id: z.string(),
	token: z.string(),
	url: z.string(),
	role: Role,
	admin: z.boolean(),
	maxUses: z.number().int(),
	expiresAt: z.number(),
});
export type InviteCreated = z.infer<typeof InviteCreated>;

export const BootstrapResponse = z.object({ workspace: WorkspaceSummary, invite: InviteCreated });
export type BootstrapResponse = z.infer<typeof BootstrapResponse>;

export const InviteCreateRequest = z.object({
	role: Role,
	maxUses: z.number().int().min(1).max(100).default(1),
	expiresInSec: z.number().int().min(300).max(2_592_000).default(INVITE_DEFAULT_TTL_S),
});
export type InviteCreateRequest = z.infer<typeof InviteCreateRequest>;

export const InviteSummary = z.object({
	id: z.string(),
	role: Role,
	admin: z.boolean(),
	uses: z.number().int(),
	maxUses: z.number().int(),
	expiresAt: z.number(),
	createdBy: z.string(),
	revoked: z.boolean(),
});
export type InviteSummary = z.infer<typeof InviteSummary>;

export const InvitesResponse = z.object({ invites: z.array(InviteSummary) });
export type InvitesResponse = z.infer<typeof InvitesResponse>;

/** Unauthenticated: a new user accepts an invite and gets a `SessionResponse`. */
export const InviteAcceptRequest = z.object({
	token: z.string(),
	device: DeviceInfo,
	name: z.string().min(1).max(60),
});
export type InviteAcceptRequest = z.infer<typeof InviteAcceptRequest>;

/** Authenticated: an existing user redeems an invite and gets a `WorkspacesResponse`. */
export const InviteRedeemRequest = z.object({ token: z.string() });
export type InviteRedeemRequest = z.infer<typeof InviteRedeemRequest>;

export const MeResponse = z.object({
	user: User,
	device: z.object({ id: z.string(), name: z.string(), platform: z.string() }),
	workspaces: z.array(WorkspaceSummary),
});

export const WsTokenRequest = z.object({ workspaceId: z.string() });
export const WsTokenResponse = z.object({ token: z.string(), expiresAt: z.number() });

export const DeviceCodeStartRequest = z.object({ device: DeviceInfo });
export type DeviceCodeStartRequest = z.infer<typeof DeviceCodeStartRequest>;

export const DeviceCodeResponse = z.object({
	deviceCode: z.string(),
	userCode: z.string(),
	verificationUri: z.string(),
	interval: z.number(),
	expiresIn: z.number(),
});
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponse>;

export const DeviceCodePollRequest = z.object({ deviceCode: z.string() });
export type DeviceCodePollRequest = z.infer<typeof DeviceCodePollRequest>;

export const DeviceLookupResponse = z.object({
	device: z.object({ name: z.string(), platform: z.string() }),
	expiresAt: z.number(),
});
export type DeviceLookupResponse = z.infer<typeof DeviceLookupResponse>;

export const DeviceApproveRequest = z.object({ userCode: z.string(), approve: z.boolean() });
export type DeviceApproveRequest = z.infer<typeof DeviceApproveRequest>;

export const Member = z.object({
	user: z.object({ id: z.string(), name: z.string(), color: z.string() }),
	role: Role,
});
export type Member = z.infer<typeof Member>;

export const MembersResponse = z.object({ members: z.array(Member) });
export type MembersResponse = z.infer<typeof MembersResponse>;

export const MemberUpdateRequest = z.object({ role: Role });
export type MemberUpdateRequest = z.infer<typeof MemberUpdateRequest>;

export const WorkspaceCreateRequest = z.object({ name: z.string().min(1).max(60) });
export type WorkspaceCreateRequest = z.infer<typeof WorkspaceCreateRequest>;

export const AuditEntry = z.object({
	id: z.number(),
	at: z.number(),
	actorId: z.string().nullable(),
	action: z.string(),
	target: z.string(),
	details: z.unknown(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditResponse = z.object({
	entries: z.array(AuditEntry),
	next: z.number().nullable(),
});
export type AuditResponse = z.infer<typeof AuditResponse>;

export const ChunkSha = z.string().regex(/^[0-9a-f]{64}$/);
export type ChunkSha = z.infer<typeof ChunkSha>;

export const ChunksMissingRequest = z.object({
	shas: z.array(ChunkSha).min(1).max(CHUNKS_MISSING_MAX),
});
export type ChunksMissingRequest = z.infer<typeof ChunksMissingRequest>;

export const ChunksMissingResponse = z.object({ missing: z.array(z.string()) });
export type ChunksMissingResponse = z.infer<typeof ChunksMissingResponse>;

export const ChunkPutResponse = z.object({ created: z.boolean() });
export type ChunkPutResponse = z.infer<typeof ChunkPutResponse>;

/** `sv` is a base64 Yjs state vector; without it the relay returns the full merged state. */
export const CloneRequest = z.object({
	docs: z
		.array(z.object({ doc: z.string(), sv: z.string().optional() }))
		.min(1)
		.max(CLONE_MAX_DOCS),
});
export type CloneRequest = z.infer<typeof CloneRequest>;

export const ServerInfo = z.object({
	name: z.string(),
	version: z.string(),
	publicUrl: z.string(),
	features: z.object({
		devOpenLogin: z.boolean(),
		presign: z.boolean(),
		excalidraw: z.boolean(),
		textKeepalive: z.boolean().optional(),
		presenceRenewalMs: z.number().optional(),
		accounts: z.boolean().optional(),
		chunks: z.boolean().optional(),
		bulkClone: z.boolean().optional(),
	}),
	limits: z.object({ maxFileBytes: z.number(), chunkBytes: z.number() }),
});
export type ServerInfo = z.infer<typeof ServerInfo>;

/** Value stored under each path key in the index doc's `files` Y.Map. */
export const FileMeta = z.object({
	id: z.string(),
	kind: FileKind,
	hash: z.string().optional(),
	size: z.number().optional(),
	mtime: z.number().optional(),
	chunks: z.array(z.string()).optional(),
	mime: z.string().optional(),
	updatedBy: z.string(),
	updatedAt: z.number(),
});
export type FileMeta = z.infer<typeof FileMeta>;

export const FilesResponse = z.object({ files: z.array(FileMeta.extend({ path: z.string() })) });
export type FilesResponse = z.infer<typeof FilesResponse>;

/** Value stored under each fileId key in the index doc's `docRevs` Y.Map. */
export const DocRev = z.object({ at: z.number(), by: z.string() });
export type DocRev = z.infer<typeof DocRev>;

export const Version = z.object({
	id: z.string(),
	name: z.string().nullable(),
	trigger: z.enum(["auto", "manual", "revert", "backup"]),
	createdBy: z.object({ id: z.string(), name: z.string(), color: z.string() }).nullable(),
	contributors: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })),
	atSeq: z.number(),
	createdAt: z.string(),
});
export type Version = z.infer<typeof Version>;

export const ApiError = z.object({
	error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

/** Hocuspocus stateless messages (JSON). */
export const StatelessMessage = z.discriminatedUnion("t", [
	z.object({
		t: z.literal("version.created"),
		docId: z.string(),
		versionId: z.string(),
		trigger: z.string(),
	}),
	z.object({ t: z.literal("membership.changed"), workspaceId: z.string() }),
	z.object({ t: z.literal("summon"), from: z.string(), file: z.string() }),
]);
export type StatelessMessage = z.infer<typeof StatelessMessage>;
