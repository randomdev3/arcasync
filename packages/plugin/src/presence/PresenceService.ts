import {
	PRESENCE_IDLE_AFTER_MS,
	type PresenceUser,
	userColor,
	WorkspacePresence,
} from "@teamsync/shared";
import type { Awareness } from "y-protocols/awareness";
import type { IPresence } from "../workspace/types";

/** Minimum time between two published idle flips (the budget's "presence changes" row). */
export const IDLE_FLIP_MIN_MS = 60_000;

/**
 * The one `user` shape this client publishes, on the index awareness and on the focused note's
 * awareness alike. `id` must be the JWT `sub` (the relay closes the socket with 4403 otherwise);
 * colours come from the shared palette so avatars and carets match.
 */
export function presenceUser(user: { id: string; name: string }): PresenceUser {
	return { id: user.id, name: user.name, ...userColor(user.id) };
}

export interface PresenceServiceOptions {
	/** The workspace index doc's awareness. */
	awareness: Awareness;
	user: PresenceUser;
	device: WorkspacePresence["device"];
	/** Whether the window starts hidden. */
	hidden?: boolean;
	idleAfterMs?: number;
	idleFlipMinMs?: number;
	/** Called right before an idle flip is published; refresh the presence policies here. */
	onIdleChange?: () => void;
}

/**
 * Workspace presence on the index-doc awareness: publishes this client's `WorkspacePresence`
 * (focused file, idle) and reads everyone's back, validated, grouped by user.
 *
 * Traffic: the local state is published only when `file` or `idle` actually changes. Input only
 * records a timestamp; idle flips are rate limited to one per `idleFlipMinMs` (the first one is
 * immediate), so a flapping window costs at most one update a minute.
 */
export class PresenceService implements IPresence {
	readonly user: PresenceUser;
	private readonly awareness: Awareness;
	private readonly device: WorkspacePresence["device"];
	private readonly idleAfterMs: number;
	private readonly idleFlipMinMs: number;
	private readonly onIdleChange: () => void;
	private file: string | null = null;
	private hidden: boolean;
	private current: boolean;
	private lastInput = Date.now();
	private lastFlip = Number.NEGATIVE_INFINITY;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private flipTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	constructor(options: PresenceServiceOptions) {
		this.awareness = options.awareness;
		this.user = options.user;
		this.device = options.device;
		this.idleAfterMs = options.idleAfterMs ?? PRESENCE_IDLE_AFTER_MS;
		this.idleFlipMinMs = options.idleFlipMinMs ?? IDLE_FLIP_MIN_MS;
		this.onIdleChange = options.onIdleChange ?? (() => {});
		this.hidden = options.hidden ?? false;
		this.current = this.hidden;
		this.publish();
		this.evaluate();
	}

	get idle(): boolean {
		return this.current;
	}

	/** Workspace path of the focused note, or null. */
	get focusedFile(): string | null {
		return this.file;
	}

	/** Sets the focused note (workspace path, or null); publishes only on a change. */
	setFile(file: string | null): void {
		if (file === this.file) return;
		this.file = file;
		this.publish();
	}

	/** Keyboard or pointer input. Cheap enough for every mousemove. */
	input(): void {
		this.lastInput = Date.now();
		if (this.current || this.flipTimer !== null) this.evaluate();
	}

	setHidden(hidden: boolean): void {
		if (hidden === this.hidden) return;
		this.hidden = hidden;
		this.evaluate();
	}

	users(): Map<string, WorkspacePresence[]> {
		const users = new Map<string, WorkspacePresence[]>();
		for (const state of this.awareness.getStates().values()) {
			const parsed = WorkspacePresence.safeParse(state);
			if (!parsed.success) continue;
			const id = parsed.data.user.id;
			const devices = users.get(id);
			if (devices) devices.push(parsed.data);
			else users.set(id, [parsed.data]);
		}
		return users;
	}

	onChange(listener: () => void): () => void {
		const handler = () => listener();
		this.awareness.on("change", handler);
		return () => this.awareness.off("change", handler);
	}

	dispose(): void {
		this.disposed = true;
		if (this.idleTimer !== null) clearTimeout(this.idleTimer);
		if (this.flipTimer !== null) clearTimeout(this.flipTimer);
		this.idleTimer = null;
		this.flipTimer = null;
	}

	private evaluate(): void {
		if (this.disposed) return;
		const now = Date.now();
		const inputIdle = now - this.lastInput >= this.idleAfterMs;
		if (!inputIdle && this.idleTimer === null) {
			this.idleTimer = setTimeout(
				() => {
					this.idleTimer = null;
					this.evaluate();
				},
				this.lastInput + this.idleAfterMs - now,
			);
		}
		const next = this.hidden || inputIdle;
		if (next === this.current) {
			if (this.flipTimer !== null) clearTimeout(this.flipTimer);
			this.flipTimer = null;
			return;
		}
		const wait = this.lastFlip + this.idleFlipMinMs - now;
		if (wait <= 0) {
			this.current = next;
			this.lastFlip = now;
			// Same tick as the state change, so the policy's `renewMs` rides the same flush.
			this.onIdleChange();
			this.publish();
		} else if (this.flipTimer === null) {
			this.flipTimer = setTimeout(() => {
				this.flipTimer = null;
				this.evaluate();
			}, wait);
		}
	}

	private publish(): void {
		const prev = this.awareness.getLocalState();
		if (prev === null) return;
		const state: WorkspacePresence = {
			user: this.user,
			device: this.device,
			file: this.file,
			following: null,
			idle: this.current,
			ts: Date.now(),
		};
		// Merge: the presence policy's `renewMs` lives in the same state.
		this.awareness.setLocalState({ ...prev, ...state });
	}
}
