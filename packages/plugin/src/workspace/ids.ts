const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LENGTH = 21;

/** A new file id: 21 random base64url characters (126 bits), valid in a doc name. */
export function newFileId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(LENGTH));
	let id = "";
	for (const b of bytes) id += ALPHABET[b & 63];
	return id;
}
