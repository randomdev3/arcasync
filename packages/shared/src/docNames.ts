import { z } from "zod";

export const DocKind = z.enum(["index", "md", "canvas", "xd"]);
export type DocKind = z.infer<typeof DocKind>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface DocRef {
	workspaceId: string;
	kind: DocKind;
	fileId?: string;
}

/** `ws:<workspaceId>:index` or `ws:<workspaceId>:<kind>:<fileId>` */
export function docName(ref: DocRef): string {
	if (!ID.test(ref.workspaceId)) throw new Error(`bad workspaceId ${ref.workspaceId}`);
	if (ref.kind === "index") return `ws:${ref.workspaceId}:index`;
	if (!ref.fileId || !ID.test(ref.fileId)) throw new Error(`bad fileId ${ref.fileId}`);
	return `ws:${ref.workspaceId}:${ref.kind}:${ref.fileId}`;
}

export function parseDocName(name: string): DocRef | null {
	const parts = name.split(":");
	if (parts[0] !== "ws") return null;
	const workspaceId = parts[1];
	if (!workspaceId || !ID.test(workspaceId)) return null;
	if (parts.length === 3 && parts[2] === "index") return { workspaceId, kind: "index" };
	if (parts.length === 4) {
		const kind = DocKind.safeParse(parts[2]);
		const fileId = parts[3];
		if (!kind.success || kind.data === "index" || !fileId || !ID.test(fileId)) return null;
		return { workspaceId, kind: kind.data, fileId };
	}
	return null;
}
