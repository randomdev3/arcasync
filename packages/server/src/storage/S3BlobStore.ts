import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import type { S3Config } from "../config.js";
import { assertSha256, type BlobStore } from "./BlobStore.js";

function isNotFound(err: unknown): boolean {
	const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
	return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

/** Content-addressed chunk store on S3-compatible object storage. */
export class S3BlobStore implements BlobStore {
	readonly backend = "s3" as const;
	private readonly client: S3Client;

	constructor(private readonly config: S3Config) {
		this.client = new S3Client({
			region: config.region,
			endpoint: config.endpoint || undefined,
			forcePathStyle: config.forcePathStyle,
			credentials: config.accessKeyId
				? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
				: undefined,
		});
	}

	private key(sha256: string): string {
		assertSha256(sha256);
		return `chunks/${sha256}`;
	}

	async put(sha256: string, bytes: Uint8Array): Promise<{ created: boolean }> {
		try {
			await this.client.send(
				new PutObjectCommand({
					Bucket: this.config.bucket,
					Key: this.key(sha256),
					Body: bytes,
					ContentLength: bytes.byteLength,
					// Content-addressed: never overwrite an existing chunk.
					IfNoneMatch: "*",
				}),
			);
			return { created: true };
		} catch (err) {
			const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
				?.httpStatusCode;
			// 412 (PreconditionFailed) / 409 mean the object already exists.
			if (status === 412 || status === 409) return { created: false };
			throw err;
		}
	}

	async get(sha256: string): Promise<Uint8Array | null> {
		try {
			const res = await this.client.send(
				new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(sha256) }),
			);
			if (!res.Body) return null;
			return new Uint8Array(await res.Body.transformToByteArray());
		} catch (err) {
			if (isNotFound(err)) return null;
			throw err;
		}
	}

	async has(sha256: string): Promise<boolean> {
		try {
			await this.client.send(
				new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.key(sha256) }),
			);
			return true;
		} catch (err) {
			if (isNotFound(err)) return false;
			throw err;
		}
	}

	async delete(sha256: string): Promise<void> {
		await this.client.send(
			new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.key(sha256) }),
		);
	}

	async ping(): Promise<void> {
		await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
	}
}
