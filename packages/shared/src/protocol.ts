import { z } from "zod";
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
});
export const InviteAcceptRequest = z.object({
	token: z.string(),
	device: DeviceInfo,
	name: z.string().optional(),
});

export const MeResponse = z.object({
	user: User,
	device: z.object({ id: z.string(), name: z.string(), platform: z.string() }),
	workspaces: z.array(WorkspaceSummary),
});

export const WsTokenRequest = z.object({ workspaceId: z.string() });
export const WsTokenResponse = z.object({ token: z.string(), expiresAt: z.number() });

export const DeviceCodeResponse = z.object({
	deviceCode: z.string(),
	userCode: z.string(),
	verificationUri: z.string(),
	interval: z.number(),
	expiresIn: z.number(),
});

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
