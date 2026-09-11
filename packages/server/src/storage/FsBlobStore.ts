import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type BlobStore, assertSha256 } from "./BlobStore.js";

/** Content-addressed chunk store on disk: `<root>/<aa>/<sha256>`. */
export class FsBlobStore implements BlobStore {
	readonly backend = "fs" as const;

	constructor(private readonly root: string) {}

	private pathFor(sha256: string): string {
		assertSha256(sha256);
		return path.join(this.root, sha256.slice(0, 2), sha256);
	}

	async put(sha256: string, bytes: Uint8Array): Promise<{ created: boolean }> {
		const target = this.pathFor(sha256);
		if (await this.has(sha256)) return { created: false };
		await mkdir(path.dirname(target), { recursive: true });
		const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
		await writeFile(tmp, bytes);
		try {
			await rename(tmp, target);
		} catch (err) {
			await rm(tmp, { force: true });
			throw err;
		}
		return { created: true };
	}

	async get(sha256: string): Promise<Uint8Array | null> {
		try {
			const buf = await readFile(this.pathFor(sha256));
			return new Uint8Array(buf);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
	}

	async has(sha256: string): Promise<boolean> {
		try {
			await access(this.pathFor(sha256), constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	async delete(sha256: string): Promise<void> {
		await rm(this.pathFor(sha256), { force: true });
	}

	async ping(): Promise<void> {
		await mkdir(this.root, { recursive: true });
	}
}
