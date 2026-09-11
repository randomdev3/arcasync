import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { DeviceRow, SessionRow, UserRow } from "./db/schema.js";
import type { Logger } from "./log.js";
import type { BlobStore } from "./storage/BlobStore.js";

export interface Deps {
	db: Db;
	config: Config;
	blobs: BlobStore;
	log: Logger;
}

export type AppEnv = {
	Variables: {
		user: UserRow;
		session: SessionRow;
		device: DeviceRow;
	};
};
