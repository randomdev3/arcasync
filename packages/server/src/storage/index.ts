import type { Config } from "../config.js";
import type { BlobStore } from "./BlobStore.js";
import { FsBlobStore } from "./FsBlobStore.js";
import { S3BlobStore } from "./S3BlobStore.js";

export type { BlobStore };
export { FsBlobStore, S3BlobStore };

export function createBlobStore(config: Config): BlobStore {
	if (config.blobBackend === "s3") return new S3BlobStore(config.s3);
	return new FsBlobStore(config.blobDir);
}
