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

/** The copy shared by every page (`unauthorized` is handled by each page's signed-out state). */
export function describeError(failure: Pick<ApiFailure, "code" | "message">): ErrorCopy {
	switch (failure.code) {
		case "network":
			return {
				message: "Can't reach the ArcaSync server. Check your connection and try again.",
				retry: true,
			};
		case "rate_limited":
			return { message: "Too many tries. Wait a minute and try again." };
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
