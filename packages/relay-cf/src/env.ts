import type { AccountsDO } from "./AccountsDO";
import type { WorkspaceRelay } from "./WorkspaceRelay";

export interface Env {
	ACCOUNTS: DurableObjectNamespace<AccountsDO>;
	RELAY: DurableObjectNamespace<WorkspaceRelay>;
	TEAMSYNC_SECRET: string;
	TEAMSYNC_DEV_OPEN_LOGIN: string;
	TEAMSYNC_DEBUG_STATS: string;
	TEAMSYNC_MAX_FILE_BYTES: string;
	TEAMSYNC_PUBLIC_URL?: string;
}
