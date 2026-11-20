/** A flow: a state machine with no DOM, driven by `send` and rendered by its page. */
export interface Flow<S, E> {
	getState(): S;
	send(event: E): void;
	subscribe(listener: (state: S) => void): () => void;
}

export interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Store<S> {
	get(): S;
	set(next: S): void;
	subscribe(listener: (state: S) => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
	let state = initial;
	const listeners = new Set<(state: S) => void>();
	return {
		get: () => state,
		set(next) {
			state = next;
			for (const listener of [...listeners]) listener(state);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** Profile fields the pages show (from `SessionResponse.user` or `MeResponse.user`). */
export interface Person {
	name: string;
	color: string;
	isAdmin: boolean;
}

export interface WorkspaceRow {
	name: string;
	role: string;
}

export function person(user: unknown): Person | null {
	const u = user as { name?: unknown; color?: unknown; isAdmin?: unknown } | null;
	if (!u || typeof u.name !== "string") return null;
	return {
		name: u.name,
		color: typeof u.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(u.color) ? u.color : "",
		isAdmin: u.isAdmin === true,
	};
}

export function workspaceRows(list: unknown): WorkspaceRow[] {
	if (!Array.isArray(list)) return [];
	return list.flatMap((w) => {
		const ws = w as { name?: unknown; role?: unknown };
		return typeof ws.name === "string" && typeof ws.role === "string"
			? [{ name: ws.name, role: ws.role }]
			: [];
	});
}

/** The rest of the signed-in user that /account shows (kept apart from `Person`). */
export interface Profile {
	id: string;
	email: string | null;
	/** An https picture from Google or GitHub, or null. */
	avatarUrl: string | null;
}

export function profile(user: unknown): Profile {
	const u = user as { id?: unknown; email?: unknown; avatarUrl?: unknown } | null;
	return {
		id: typeof u?.id === "string" ? u.id : "",
		email: typeof u?.email === "string" && u.email ? u.email : null,
		avatarUrl: safeAvatar(u?.avatarUrl),
	};
}

/** Only https pictures (the CSP allows Google's and GitHub's). */
export function safeAvatar(url: unknown): string | null {
	return typeof url === "string" && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null;
}
