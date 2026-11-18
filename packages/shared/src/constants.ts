export const CHUNK_BYTES = 4 * 1024 * 1024;
export const WS_PATH = "/ws";
export const API_PREFIX = "/api";
export const WS_TOKEN_TTL_SECONDS = 15 * 60;
export const AWARENESS_IDLE_MS = 60_000;
export const FLUSH_DELAY_MS = 1000;
export const KEEPALIVE_INTERVAL_MS = 90_000;
export const KEEPALIVE_RECONNECT_TIMEOUT_MS = 240_000;
export const KEEPALIVE_PING = "ping";
export const KEEPALIVE_PONG = "pong";
export const PRESENCE_RENEWAL_MS = 120_000;
export const PRESENCE_IDLE_RENEWAL_MS = 900_000;
export const PRESENCE_IDLE_AFTER_MS = 300_000;
export const PRESENCE_TIMEOUT_FACTOR = 2.75;
export const PRESENCE_DEFAULT_TIMEOUT_MS = 30_000;
export const CODEC_YJS_V1 = 1;
/** Index-doc Y.Map of path → `FileMeta`. */
export const INDEX_FILES = "files";
/** Index-doc Y.Map of fileId → `DocRev`, bumped after the relay acks a note's local changes. */
export const INDEX_REVS = "docRevs";
