import type { ApiFailure } from "./api";

export const MISCONFIGURED_COPY = "The server isn't set up yet. Tell whoever runs it.";
export const DISABLED_COPY = "This account is disabled. Ask an admin to re-enable it.";
export const RATE_LIMIT_COOLDOWN_MS = 60_000;

export interface ErrorCopy {
	message: string;
	/** Shown after the message in mono, for codes without their own copy. */
	code?: string;
	/** A Retry action makes sense (network). */
	retry?: boolean;
}

/** Seconds → "40 s", "12 min", "3 h" (rounded up). */
export function formatWait(seconds: number): string {
	if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} s`;
	if (seconds < 5400) return `${Math.ceil(seconds / 60)} min`;
	return `${Math.ceil(seconds / 3600)} h`;
}

export const PINS_LOCKED_COPY =
	"PIN entry is locked after too many wrong PINs. Ask whoever runs the server, or use an invite link.";

/** The copy shared by every page (`unauthorized` is handled by each page's signed-out state). */
export function describeError(
	failure: Pick<ApiFailure, "code" | "message" | "retryAfter">,
): ErrorCopy {
	switch (failure.code) {
		case "network":
			return {
				message: "Can't reach the ArcaSync server. Check your connection and try again.",
				retry: true,
			};
		case "rate_limited":
			return {
				message:
					failure.retryAfter === undefined
						? "Too many tries. Wait a minute and try again."
						: `Too many tries. Try again in ${formatWait(failure.retryAfter)}.`,
			};
		case "pins_locked":
			return { message: PINS_LOCKED_COPY };
		case "invalid_pin":
			return { message: "That PIN is wrong, already used or expired." };
		case "invalid_credentials":
			return { message: "Wrong name or password." };
		case "too_many_pins":
			return { message: "At most 10 PINs can be open at once. Revoke one first." };
		case "limit_reached":
			return { message: failure.message || "You've hit a limit on this server." };
		case "team_forbidden":
			return { message: "Only the team's owners can do that." };
		case "server_error":
		case "internal":
			return { message: "Something broke on the server. Try again in a bit.", retry: true };
		case "misconfigured":
			return { message: MISCONFIGURED_COPY };
		case "forbidden":
			return { message: DISABLED_COPY };
		case "unauthorized":
			return { message: "You've been signed out." };
		default:
			return { message: failure.message || "Something went wrong.", code: failure.code };
	}
}
