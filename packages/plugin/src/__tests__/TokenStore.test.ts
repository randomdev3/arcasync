import { describe, expect, it, vi } from "vitest";
import { REFRESH_MARGIN_MS, TokenStore, type WsToken } from "../net/TokenStore";

const MINUTE = 60 * 1000;

function store(tokens: WsToken[], now: () => number) {
	const fetchToken = vi.fn(async () => {
		const next = tokens.shift();
		if (!next) throw new Error("no more tokens queued");
		return next;
	});
	return { fetchToken, tokenStore: new TokenStore({ fetchToken, now }) };
}

describe("TokenStore", () => {
	it("caches a token until it enters the refresh margin", async () => {
		let clock = 0;
		const { fetchToken, tokenStore } = store(
			[
				{ token: "first", expiresAt: 15 * MINUTE },
				{ token: "second", expiresAt: 30 * MINUTE },
			],
			() => clock,
		);

		expect(await tokenStore.get("ws1")).toBe("first");
		clock = 10 * MINUTE;
		expect(await tokenStore.get("ws1")).toBe("first");
		expect(fetchToken).toHaveBeenCalledTimes(1);

		// Exactly 2 minutes of life left: inside the margin, so refresh.
		clock = 15 * MINUTE - REFRESH_MARGIN_MS;
		expect(await tokenStore.get("ws1")).toBe("second");
		expect(fetchToken).toHaveBeenCalledTimes(2);
	});

	it("treats a missing or expiring token as stale", () => {
		const { tokenStore } = store([], () => 0);
		expect(tokenStore.isStale(undefined)).toBe(true);
		expect(tokenStore.isStale({ token: "t", expiresAt: REFRESH_MARGIN_MS })).toBe(true);
		expect(tokenStore.isStale({ token: "t", expiresAt: REFRESH_MARGIN_MS + 1 })).toBe(false);
	});

	it("coalesces concurrent requests for the same workspace", async () => {
		const { fetchToken, tokenStore } = store([{ token: "one", expiresAt: 15 * MINUTE }], () => 0);
		const [a, b, c] = await Promise.all([
			tokenStore.get("ws1"),
			tokenStore.get("ws1"),
			tokenStore.get("ws1"),
		]);
		expect([a, b, c]).toEqual(["one", "one", "one"]);
		expect(fetchToken).toHaveBeenCalledTimes(1);
	});

	it("keeps separate caches per workspace", async () => {
		const { fetchToken, tokenStore } = store(
			[
				{ token: "a", expiresAt: 15 * MINUTE },
				{ token: "b", expiresAt: 15 * MINUTE },
			],
			() => 0,
		);
		expect(await tokenStore.get("ws1")).toBe("a");
		expect(await tokenStore.get("ws2")).toBe("b");
		expect(fetchToken).toHaveBeenCalledTimes(2);
	});

	it("does not wedge later callers after a failed fetch", async () => {
		const fetchToken = vi
			.fn<(workspaceId: string) => Promise<WsToken>>()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({ token: "recovered", expiresAt: 15 * MINUTE });
		const tokenStore = new TokenStore({ fetchToken, now: () => 0 });

		await expect(tokenStore.get("ws1")).rejects.toThrow("offline");
		expect(await tokenStore.get("ws1")).toBe("recovered");
	});

	it("forgets one workspace or all of them on invalidate", async () => {
		const { fetchToken, tokenStore } = store(
			[
				{ token: "a1", expiresAt: 15 * MINUTE },
				{ token: "a2", expiresAt: 15 * MINUTE },
			],
			() => 0,
		);
		expect(await tokenStore.get("ws1")).toBe("a1");
		tokenStore.invalidate("ws1");
		expect(await tokenStore.get("ws1")).toBe("a2");
		expect(fetchToken).toHaveBeenCalledTimes(2);
	});
});
