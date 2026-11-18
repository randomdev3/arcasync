import * as time from "lib0/time";
import { type Awareness, removeAwarenessStates } from "y-protocols/awareness";
import { PRESENCE_DEFAULT_TIMEOUT_MS, PRESENCE_TIMEOUT_FACTOR } from "./constants.js";

/** Upper bound of the renew/expire tick; production renewals (120 s) give exactly this. */
export const PRESENCE_CHECK_MAX_MS = 30_000;

export interface PresencePolicyOptions {
	activeRenewMs: number;
	idleRenewMs: number;
	isIdle: () => boolean;
	/** Renew/expire tick. Default `min(30 s, activeRenewMs / 4)`. */
	checkIntervalMs?: number;
}

export interface PresencePolicy {
	/** The renewal interval currently advertised as `renewMs` in the local state. */
	readonly renewMs: number;
	/** Re-evaluate `isIdle`; publishes the new `renewMs` only when it changes. */
	refresh(): void;
	dispose(): void;
}

/**
 * Replaces y-protocols' awareness interval, which renews the local state every 15 s and drops
 * remote states after 30 s. One interval does both, so every client must run this policy:
 * - the local state is renewed every `renewMs` (active or idle) and advertises it as `renewMs`;
 * - a remote state expires after `PRESENCE_TIMEOUT_FACTOR × its advertised renewMs`, or after
 *   `PRESENCE_DEFAULT_TIMEOUT_MS` when it advertises none.
 * Clean and hard disconnects are covered by the relay's close-driven removal, not by expiry.
 */
export function installPresencePolicy(
	awareness: Awareness,
	{ activeRenewMs, idleRenewMs, isIdle, checkIntervalMs }: PresencePolicyOptions,
): PresencePolicy {
	clearInterval(awareness._checkInterval);
	let renewMs = isIdle() ? idleRenewMs : activeRenewMs;

	const publish = () => {
		const state = awareness.getLocalState();
		if (state !== null && state.renewMs !== renewMs) {
			awareness.setLocalStateField("renewMs", renewMs);
		}
	};

	// A wholesale `setLocalState({...})` (editor binding, focus switch) drops `renewMs`;
	// without it peers would fall back to the 30 s default and drop this client.
	const onUpdate = (_changes: unknown, origin: unknown) => {
		if (origin === "local") publish();
	};

	const tick = () => {
		const now = time.getUnixTime();
		const local = awareness.getLocalState();
		const meta = awareness.meta.get(awareness.clientID);
		if (local !== null && meta && now - meta.lastUpdated >= renewMs) {
			awareness.setLocalState(local);
		}
		const expired: number[] = [];
		for (const [clientId, state] of awareness.getStates()) {
			if (clientId === awareness.clientID) continue;
			const lastUpdated = awareness.meta.get(clientId)?.lastUpdated;
			if (lastUpdated === undefined) continue;
			const timeoutMs =
				typeof state.renewMs === "number"
					? PRESENCE_TIMEOUT_FACTOR * state.renewMs
					: PRESENCE_DEFAULT_TIMEOUT_MS;
			if (now - lastUpdated >= timeoutMs) expired.push(clientId);
		}
		if (expired.length > 0) removeAwarenessStates(awareness, expired, "timeout");
	};

	const interval = setInterval(
		tick,
		checkIntervalMs ?? Math.min(PRESENCE_CHECK_MAX_MS, activeRenewMs / 4),
	);

	const dispose = () => {
		clearInterval(interval);
		awareness.off("update", onUpdate);
		awareness.off("destroy", dispose);
	};

	awareness.on("update", onUpdate);
	awareness.on("destroy", dispose);
	publish();

	return {
		get renewMs() {
			return renewMs;
		},
		refresh() {
			const next = isIdle() ? idleRenewMs : activeRenewMs;
			if (next === renewMs) return;
			renewMs = next;
			publish();
		},
		dispose,
	};
}
