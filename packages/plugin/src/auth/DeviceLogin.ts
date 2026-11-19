import {
	DEVICE_CODE_INTERVAL_S,
	type DeviceCodeResponse,
	type DeviceInfo,
	type SessionResponse,
} from "@teamsync/shared";
import { type ApiClient, ApiRequestError, NetworkError } from "../net/ApiClient";

/** Added to the poll interval on every `slow_down` (RFC 8628 §3.5). */
const SLOW_DOWN_STEP_MS = 5000;

/** The sign-in ended without a session: expired, denied, or cancelled on this device. */
export class DeviceLoginError extends Error {
	constructor(
		readonly code: "expired_token" | "access_denied" | "cancelled",
		message: string,
	) {
		super(message);
		this.name = "DeviceLoginError";
	}
}

export interface DeviceLoginOptions {
	api: Pick<ApiClient, "deviceStart" | "devicePoll">;
	device: DeviceInfo;
}

/**
 * Device-code sign-in (D2): starts a code, then polls until another device approves it. Polls
 * never come faster than the server's interval (at least `DEVICE_CODE_INTERVAL_S`), each one is
 * scheduled only after the previous answer, so there is never more than one request in flight.
 */
export class DeviceLogin {
	private done = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private intervalMs = DEVICE_CODE_INTERVAL_S * 1000;
	private deadline = 0;
	private deviceCode = "";
	private settle: { resolve(s: SessionResponse): void; reject(e: unknown): void } | null = null;

	constructor(private readonly options: DeviceLoginOptions) {}

	/** Starts the sign-in; `onCode` gets the code to show. Resolves with the new session. */
	run(onCode: (code: DeviceCodeResponse) => void): Promise<SessionResponse> {
		if (this.settle || this.done) return Promise.reject(new Error("DeviceLogin already ran"));
		const result = new Promise<SessionResponse>((resolve, reject) => {
			this.settle = { resolve, reject };
		});
		void this.begin(onCode);
		return result;
	}

	/** Stops polling; no request is sent after this. The `run` promise rejects with `cancelled`. */
	cancel(): void {
		this.fail(new DeviceLoginError("cancelled", "Sign-in cancelled"));
	}

	private async begin(onCode: (code: DeviceCodeResponse) => void): Promise<void> {
		let code: DeviceCodeResponse;
		try {
			code = await this.options.api.deviceStart(this.options.device);
		} catch (error) {
			this.fail(error);
			return;
		}
		if (this.done) return;
		this.deviceCode = code.deviceCode;
		this.intervalMs = Math.max(code.interval, DEVICE_CODE_INTERVAL_S) * 1000;
		this.deadline = Date.now() + code.expiresIn * 1000;
		onCode(code);
		this.schedule();
	}

	private schedule(): void {
		if (this.done) return;
		this.timer = setTimeout(() => void this.poll(), this.intervalMs);
	}

	private async poll(): Promise<void> {
		this.timer = null;
		if (this.done) return;
		if (Date.now() >= this.deadline) {
			this.fail(new DeviceLoginError("expired_token", "The sign-in code expired"));
			return;
		}
		let session: SessionResponse;
		try {
			session = await this.options.api.devicePoll(this.deviceCode);
		} catch (error) {
			if (this.done) return;
			if (error instanceof NetworkError) return this.schedule();
			if (error instanceof ApiRequestError) {
				if (error.code === "authorization_pending") return this.schedule();
				if (error.code === "slow_down") {
					this.intervalMs += SLOW_DOWN_STEP_MS;
					return this.schedule();
				}
				if (error.code === "expired_token" || error.code === "access_denied") {
					this.fail(new DeviceLoginError(error.code, error.message));
					return;
				}
			}
			this.fail(error);
			return;
		}
		if (this.done) return;
		this.done = true;
		this.settle?.resolve(session);
	}

	private fail(error: unknown): void {
		if (this.done) return;
		this.done = true;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		this.settle?.reject(error);
	}
}
