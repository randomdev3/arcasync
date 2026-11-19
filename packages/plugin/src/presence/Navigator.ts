import type { PresenceUser, WorkspacePresence } from "@arcasync/shared";
import type { INavigator, IPresence } from "../workspace/types";

/** What the Navigator needs from Obsidian; files are workspace paths. */
export interface NavigatorPort {
	/** Shows the note in the active leaf; false when it is not in this vault (yet). */
	open(file: string): Promise<boolean>;
	/**
	 * Waits for the note's editor to be bound and scrolls `userId`'s caret to the centre, or to
	 * the top when that user shows no caret there. Resolves whether the caret was shown.
	 */
	reveal(file: string, userId: string): Promise<boolean>;
	/** Keeps `userId`'s caret in view while it moves in `file`; returns the stop function. */
	trackCursor(file: string, userId: string): () => void;
	/** A note opened in the active leaf (null: no note, or one outside the shared folder). */
	onFileOpen(listener: (file: string | null) => void): () => void;
	/** A real key press in an editor. */
	onEditorKeydown(listener: () => void): () => void;
	/** Remembers the current place; returns the function that goes back to it, or null. */
	bookmark(): (() => void) | null;
	notify(message: string, action?: { label: string; run: () => void }): void;
}

export interface NavigatorOptions {
	presence: IPresence;
	selfId: string;
	port: NavigatorPort;
	/** Publishes the followed user in this client's presence (once per toggle). */
	publishFollowing(userId: string | null): void;
}

interface Followed {
	userId: string;
	user: PresenceUser;
	/** The target's note the follow last went to. */
	file: string | null;
}

/** The device to go to: the most recently switched active one, else the most recent. */
function placeOf(devices: WorkspacePresence[] | undefined): WorkspacePresence | null {
	if (!devices || devices.length === 0) return null;
	const latest = (list: WorkspacePresence[]) =>
		list.reduce<WorkspacePresence | null>((best, d) => (best && best.ts >= d.ts ? best : d), null);
	return latest(devices.filter((d) => !d.idle)) ?? latest(devices);
}

/**
 * Jump to another user's note and caret, or follow them across notes (P1-7).
 *
 * Following publishes `following` once per toggle and otherwise only reads: workspace presence
 * for note switches and departures, the note's awareness for caret moves. It stops on a real key
 * press in an editor, on a note opened by anything but the Navigator, and when the target goes
 * offline.
 */
export class Navigator implements INavigator {
	private followed: Followed | null = null;
	private offFollow: Array<() => void> = [];
	private offCursor: (() => void) | null = null;
	/** Bumped by every navigation and stop; a navigation that finds it changed gives up. */
	private generation = 0;
	/** Notes the Navigator itself is opening or opened last; their `file-open` is not the user's. */
	private readonly opening = new Set<string>();
	private lastOpened: string | null = null;
	private readonly listeners = new Set<() => void>();
	private disposed = false;

	constructor(private readonly options: NavigatorOptions) {}

	get following(): string | null {
		return this.followed?.userId ?? null;
	}

	/** The followed user's name and colour, for the badge. */
	get followedUser(): PresenceUser | null {
		return this.followed?.user ?? null;
	}

	/** Fires when `following` changes. Returns unsubscribe. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async jumpTo(userId: string): Promise<void> {
		if (this.disposed) return;
		const followed = this.followed;
		if (followed && followed.userId !== userId)
			this.stop(`Stopped following ${followed.user.name}`);
		const place = this.placeOf(userId);
		if (!place) {
			this.options.port.notify("That user is not online");
			return;
		}
		const name = place.user.name;
		if (place.file === null) {
			this.options.port.notify(`${name} is not in a shared note`);
			return;
		}
		const back = this.options.port.bookmark();
		const generation = ++this.generation;
		const shown = await this.go(place.file, userId, generation);
		if (shown === null) {
			if (generation === this.generation) {
				this.options.port.notify(`${name}'s note is not in this vault yet`);
			}
			return;
		}
		if (generation !== this.generation) return;
		const message = shown ? `Jumped to ${name}` : `${name}'s cursor is not visible`;
		this.options.port.notify(message, back ? { label: "Return", run: back } : undefined);
		if (this.followed?.userId === userId) this.trackCursor(place.file, generation);
	}

	follow(userId: string): void {
		if (this.disposed || userId === this.options.selfId) return;
		if (this.followed?.userId === userId) return;
		const place = this.placeOf(userId);
		if (!place) {
			this.options.port.notify("That user is not online");
			return;
		}
		if (this.followed) this.stop();
		const { port, presence } = this.options;
		this.followed = { userId, user: place.user, file: place.file };
		this.offFollow = [
			presence.onChange(() => this.presenceChanged()),
			port.onFileOpen((file) => this.fileOpened(file)),
			port.onEditorKeydown(() => this.stopFollowing()),
		];
		this.options.publishFollowing(userId);
		this.emit();
		if (place.file !== null) void this.hop(place.file);
	}

	unfollow(): void {
		this.stop();
	}

	/** Stops without publishing; the session's awareness is going away. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stop(undefined, false);
		this.listeners.clear();
	}

	private placeOf(userId: string): WorkspacePresence | null {
		if (userId === this.options.selfId) return null;
		return placeOf(this.options.presence.users().get(userId));
	}

	/** Opens `file` and reveals the caret; null when the note is not in this vault. */
	private async go(file: string, userId: string, generation: number): Promise<boolean | null> {
		const { port } = this.options;
		this.offCursor?.();
		this.offCursor = null;
		this.opening.add(file);
		this.lastOpened = file;
		let opened: boolean;
		try {
			opened = await port.open(file);
		} finally {
			this.opening.delete(file);
		}
		if (!opened) return null;
		if (generation !== this.generation) return false;
		return port.reveal(file, userId);
	}

	/** Follows the target to `file`, then keeps their caret in view. */
	private async hop(file: string): Promise<void> {
		const followed = this.followed;
		if (!followed) return;
		const generation = ++this.generation;
		const shown = await this.go(file, followed.userId, generation);
		if (shown === null || generation !== this.generation) return;
		this.trackCursor(file, generation);
	}

	private trackCursor(file: string, generation: number): void {
		const followed = this.followed;
		if (!followed || generation !== this.generation) return;
		this.offCursor?.();
		this.offCursor = this.options.port.trackCursor(file, followed.userId);
	}

	private presenceChanged(): void {
		const followed = this.followed;
		if (!followed) return;
		const place = this.placeOf(followed.userId);
		if (!place) {
			this.stop(`Stopped following ${followed.user.name}: ${followed.user.name} went offline`);
			return;
		}
		if (place.file === followed.file) return;
		followed.file = place.file;
		// A target outside the shared folder: stay put and pick up their next note.
		if (place.file !== null) void this.hop(place.file);
	}

	private fileOpened(file: string | null): void {
		if (file !== null && (this.opening.has(file) || file === this.lastOpened)) return;
		this.stopFollowing();
	}

	private stopFollowing(): void {
		const followed = this.followed;
		if (followed) this.stop(`Stopped following ${followed.user.name}`);
	}

	private stop(message?: string, publish = true): void {
		const followed = this.followed;
		this.generation++;
		this.offCursor?.();
		this.offCursor = null;
		if (!followed) return;
		this.followed = null;
		for (const off of this.offFollow.splice(0)) off();
		if (publish) this.options.publishFollowing(null);
		if (message) this.options.port.notify(message);
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
