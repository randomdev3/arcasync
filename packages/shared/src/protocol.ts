import { z } from "zod";
import {
	CHUNKS_MISSING_MAX,
	CLONE_MAX_DOCS,
	INVITE_DEFAULT_TTL_S,
	PIN_DEFAULT_TTL_S,
	PIN_MAX_TTL_S,
} from "./constants.js";
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

/**
 * `reset: true` (still behind the bootstrap secret) deletes every account, device, session,
 * membership, invite, PIN and password, then issues a fresh owner + admin invite. Workspaces and
 * their notes are kept; one named `workspaceName` is reused.
 */
export const BootstrapRequest = z.object({
	workspaceName: z.string().min(1).max(60),
	reset: z.literal(true).optional(),
});
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
	/** The account can sign in with name + password. relay-cf always sends it; absent elsewhere. */
	hasPassword: z.boolean().optional(),
});

/**
 * A password field in a request. Only bounded here: the length and common-password rules
 * (`passwordProblem`) apply where a password is set, never at sign-in.
 */
const PasswordField = z.string().min(1).max(1024);

/** Unauthenticated: sign in with name (case-insensitive) and password → `SessionResponse`. */
export const LoginRequest = z.object({
	name: z.string().min(1).max(60),
	password: PasswordField,
	device: DeviceInfo,
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** Authenticated: set a password (`current` omitted) or change it (`current` required). */
export const PasswordChangeRequest = z.object({
	current: PasswordField.optional(),
	new: PasswordField,
});
export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequest>;

/** Four decimal digits. */
/** 6 digits for new PINs; 4-digit PINs issued before teams stay valid until they expire. */
export const Pin = z.string().regex(/^[0-9]{4}([0-9]{2})?$/);

export const PinCreateRequest = z.object({
	role: Role,
	/** Server admins only: whoever uses the PIN becomes a server admin too. */
	admin: z.boolean().default(false),
	expiresInSec: z.number().int().min(300).max(PIN_MAX_TTL_S).default(PIN_DEFAULT_TTL_S),
});
export type PinCreateRequest = z.infer<typeof PinCreateRequest>;

export const PinSummary = z.object({
	id: z.string(),
	pin: Pin,
	workspaceId: z.string(),
	role: Role,
	admin: z.boolean(),
	createdAt: z.number(),
	createdBy: z.string(),
	expiresAt: z.number(),
	/** When it was used, and by whom (user name); a PIN is single-use. */
	usedAt: z.number().nullable(),
	usedBy: z.string().nullable(),
	revoked: z.boolean(),
});
export type PinSummary = z.infer<typeof PinSummary>;

export const PinsResponse = z.object({
	pins: z.array(PinSummary),
	/** PIN entry is locked server-wide after too many wrong PINs, until `lockedUntil` or an admin unlock. */
	locked: z.boolean(),
	lockedUntil: z.number().nullable(),
});
export type PinsResponse = z.infer<typeof PinsResponse>;

/** Unauthenticated: a new user joins with a PIN and sets a password → `SessionResponse`. */
export const PinAcceptRequest = z.object({
	pin: Pin,
	name: z.string().min(1).max(60),
	password: PasswordField,
	device: DeviceInfo,
});
export type PinAcceptRequest = z.infer<typeof PinAcceptRequest>;

/**
 * Unauthenticated: forgot password. An admin issues a one-time reset PIN for the user; name + PIN
 * set a new password, sign out every device and return a `SessionResponse`.
 */
export const PasswordResetRequest = z.object({
	name: z.string().min(1).max(60),
	pin: Pin,
	password: PasswordField,
	device: DeviceInfo,
});
export type PasswordResetRequest = z.infer<typeof PasswordResetRequest>;

/** Authenticated: join the PIN's workspace → `WorkspacesResponse`. */
export const PinRedeemRequest = z.object({ pin: Pin });
export type PinRedeemRequest = z.infer<typeof PinRedeemRequest>;

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

/** Sign-in methods a server offers (`ServerInfo.auth.providers`). */
export const AuthProvider = z.enum(["google", "github"]);
export type AuthProvider = z.infer<typeof AuthProvider>;

/** Who may create an account: anyone (via OAuth) or only people holding an invite. */
export const SignupPolicy = z.enum(["open", "invite"]);
export type SignupPolicy = z.infer<typeof SignupPolicy>;

/** `ServerInfo.auth` (optional there; servers without it offer password + device code only). */
export const AuthInfo = z.object({
	providers: z.array(AuthProvider),
	passwords: z.boolean(),
	signups: SignupPolicy,
	/** Team caps for this server, shown in UIs before the server would refuse. */
	limits: z.object({
		teamsPerUser: z.number(),
		membersPerTeam: z.number(),
		foldersPerTeam: z.number(),
	}),
});
export type AuthInfo = z.infer<typeof AuthInfo>;

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
		/** `POST /api/auth/login` and `POST /api/auth/password`. */
		passwords: z.boolean().optional(),
		/** PIN invites (`/api/workspaces/:id/pins`, `/api/auth/pin/accept`). */
		pins: z.boolean().optional(),
		/** `/api/teams…` (see teams.ts). */
		teams: z.boolean().optional(),
	}),
	limits: z.object({ maxFileBytes: z.number(), chunkBytes: z.number() }),
	/** Sign-in methods and signup policy; absent on servers without OAuth. */
	auth: AuthInfo.optional(),
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
