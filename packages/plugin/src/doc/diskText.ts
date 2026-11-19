import { sha256Hex } from "@arcasync/shared";

/**
 * The text a note's CRDT holds for a file's raw content: no byte-order mark, LF line endings.
 * Every comparison between disk and doc goes through this, so a CRLF file is not a "change".
 */
export function diskText(raw: string): string {
	const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
	return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/** UTF-8 size of `text` in bytes, without encoding it. */
export function utf8Bytes(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) bytes += 1;
		else if (c < 0x800) bytes += 2;
		else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next < 0xe000) {
				bytes += 4;
				i++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

/** Hash used for `lastSyncedHash` and self-write registration (of the LF text we write). */
export function textHash(text: string): Promise<string> {
	return sha256Hex(text);
}
