import { z } from "zod";

export const FileKind = z.enum(["md", "canvas", "xd", "base", "config", "binary"]);
export type FileKind = z.infer<typeof FileKind>;

/** Kind of live doc (if any) that backs a file kind. */
export function docKindForFileKind(kind: FileKind): "md" | "canvas" | "xd" | null {
	switch (kind) {
		case "md":
			return "md";
		case "canvas":
			return "canvas";
		case "xd":
			return "xd";
		default:
			return null;
	}
}

export function kindForPath(path: string): FileKind {
	const lower = path.toLowerCase();
	if (lower.startsWith(".obsidian/")) return "config";
	if (lower.endsWith(".excalidraw.md")) return "xd";
	if (lower.endsWith(".md")) return "md";
	if (lower.endsWith(".canvas")) return "canvas";
	if (lower.endsWith(".base")) return "base";
	return "binary";
}

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	avif: "image/avif",
	bmp: "image/bmp",
	pdf: "application/pdf",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	wav: "audio/wav",
	ogg: "audio/ogg",
	flac: "audio/flac",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	md: "text/markdown",
	canvas: "application/json",
	json: "application/json",
	txt: "text/plain",
	csv: "text/csv",
};

export function mimeForPath(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return MIME[ext] ?? "application/octet-stream";
}

/** Paths that must never be synced. */
export function isIgnoredPath(path: string): boolean {
	const segs = path.split("/");
	if (segs.some((s) => s === ".trash" || s === ".git" || s === "node_modules")) return true;
	// hidden files/folders are ignored except the .obsidian config allowlist (handled by kind "config")
	if (segs.some((s) => s.startsWith(".") && s !== ".obsidian")) return true;
	return false;
}
