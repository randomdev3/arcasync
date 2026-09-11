export interface BlobStore {
	readonly backend: "fs" | "s3";
	put(sha256: string, bytes: Uint8Array): Promise<{ created: boolean }>;
	get(sha256: string): Promise<Uint8Array | null>;
	has(sha256: string): Promise<boolean>;
	delete(sha256: string): Promise<void>;
	/** Liveness probe for `/api/ready`. */
	ping(): Promise<void>;
	presignPut?(sha256: string): Promise<string>;
	presignGet?(sha256: string): Promise<string>;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export function assertSha256(sha256: string): void {
	if (!SHA256_RE.test(sha256)) throw new Error(`invalid sha256: ${sha256}`);
}
