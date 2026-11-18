import { sha256Hex } from "@teamsync/shared";

/**
 * The text a note's CRDT holds for a file's raw content: no byte-order mark, LF line endings.
 * Every comparison between disk and doc goes through this, so a CRLF file is not a "change".
 */
export function diskText(raw: string): string {
	const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
	return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/** Hash used for `lastSyncedHash` and self-write registration (of the LF text we write). */
export function textHash(text: string): Promise<string> {
	return sha256Hex(text);
}
