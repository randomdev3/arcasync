import { CHUNK_BYTES } from "./constants.js";

function toHex(buf: ArrayBuffer): string {
	return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
	const bytes =
		typeof data === "string"
			? new TextEncoder().encode(data)
			: data instanceof Uint8Array
				? data
				: new Uint8Array(data);
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return toHex(digest);
}

export interface Chunk {
	sha256: string;
	offset: number;
	size: number;
	bytes: Uint8Array;
}

export async function chunkFile(data: Uint8Array, chunkBytes = CHUNK_BYTES): Promise<Chunk[]> {
	const chunks: Chunk[] = [];
	for (let offset = 0; offset < data.byteLength || (offset === 0 && data.byteLength === 0); offset += chunkBytes) {
		const bytes = data.subarray(offset, Math.min(offset + chunkBytes, data.byteLength));
		chunks.push({ sha256: await sha256Hex(bytes), offset, size: bytes.byteLength, bytes });
		if (data.byteLength === 0) break;
	}
	return chunks;
}
