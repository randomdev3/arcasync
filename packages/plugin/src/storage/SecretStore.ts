import type { App } from "obsidian";

interface SecretStorageLike {
	setSecret(id: string, secret: string): void;
	getSecret(id: string): string | null;
	listSecrets(): string[];
}

type AppWithSecrets = App & { appId?: string; secretStorage?: SecretStorageLike };

/**
 * `SecretStorage.setSecret` rejects anything but lowercase alphanumerics and
 * dashes, so the vault id is squashed before it becomes part of the id.
 */
function secretId(vaultId: string): string {
	const slug = vaultId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `teamsync-session-${slug || "default"}`;
}

function localStorageKey(vaultId: string): string {
	return `teamsync:${vaultId}:session`;
}

/**
 * Stores the opaque session token. Obsidian's OS-backed `app.secretStorage`
 * (1.11.4+) when present, `localStorage` otherwise — never `data.json`, which
 * syncs to other devices and to any vault backup.
 */
export class SecretStore {
	private readonly app: AppWithSecrets;
	readonly vaultId: string;

	constructor(app: App) {
		this.app = app as AppWithSecrets;
		this.vaultId = this.app.appId ?? app.vault.getName();
	}

	/** True when the OS keychain is available; false means the localStorage fallback. */
	get usesSecretStorage(): boolean {
		return typeof this.app.secretStorage?.getSecret === "function";
	}

	get(): string | null {
		if (this.usesSecretStorage) {
			try {
				return this.app.secretStorage?.getSecret(secretId(this.vaultId)) ?? null;
			} catch (error) {
				console.error("[TeamSync] secretStorage.getSecret failed", error);
			}
		}
		try {
			return window.localStorage.getItem(localStorageKey(this.vaultId));
		} catch {
			return null;
		}
	}

	set(token: string): void {
		if (this.usesSecretStorage) {
			try {
				this.app.secretStorage?.setSecret(secretId(this.vaultId), token);
				return;
			} catch (error) {
				console.error("[TeamSync] secretStorage.setSecret failed", error);
			}
		}
		try {
			window.localStorage.setItem(localStorageKey(this.vaultId), token);
		} catch (error) {
			console.error("[TeamSync] localStorage write failed", error);
		}
	}

	clear(): void {
		if (this.usesSecretStorage) {
			try {
				this.app.secretStorage?.setSecret(secretId(this.vaultId), "");
			} catch (error) {
				console.error("[TeamSync] secretStorage clear failed", error);
			}
		}
		try {
			window.localStorage.removeItem(localStorageKey(this.vaultId));
		} catch {
			// nothing to clean up
		}
	}
}
