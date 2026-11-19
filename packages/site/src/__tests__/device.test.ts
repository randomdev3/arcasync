import { describe, expect, it } from "vitest";
import { browserDevice, browserId, browserName, platformFrom } from "../lib/device";
import { memoryStorage } from "../lib/session";

const UA = {
	mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
	win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0",
	linux: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
	iphone:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1",
	android:
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
};

describe("platformFrom", () => {
	it("maps user agents to the relay's platforms", () => {
		expect(platformFrom(UA.mac)).toBe("macos");
		expect(platformFrom(UA.win)).toBe("windows");
		expect(platformFrom(UA.linux)).toBe("linux");
		expect(platformFrom(UA.iphone)).toBe("ios");
		expect(platformFrom(UA.android)).toBe("android");
		expect(platformFrom("curl/8")).toBe("unknown");
	});

	it("prefers the client hint", () => {
		expect(platformFrom(UA.linux, "macOS")).toBe("macos");
	});
});

describe("browserName", () => {
	it("tells browsers apart", () => {
		expect(browserName(UA.mac)).toBe("Safari");
		expect(browserName(UA.win)).toBe("Edge");
		expect(browserName(UA.linux)).toBe("Firefox");
		expect(browserName(UA.iphone)).toBe("Chrome");
		expect(browserName("curl/8")).toBe("Browser");
	});
});

describe("browserId and browserDevice", () => {
	it("creates the id once and reuses it", () => {
		const storage = memoryStorage();
		let n = 0;
		const uuid = () => `00000000-0000-4000-8000-00000000000${++n}`;
		const first = browserId(storage, uuid);
		expect(first).toMatch(/^web-/);
		expect(browserId(storage, uuid)).toBe(first);
		expect(n).toBe(1);
	});

	it("builds a valid DeviceInfo", () => {
		const device = browserDevice({ userAgent: UA.linux }, memoryStorage(), () => "abc-123-def-456");
		expect(device).toEqual({
			name: "Browser · Firefox",
			platform: "linux",
			vaultId: "web-abc-123-def-456",
		});
		expect(device.name.length).toBeLessThanOrEqual(100);
	});
});
