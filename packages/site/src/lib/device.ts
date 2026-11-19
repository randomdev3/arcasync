import type { DeviceInfo } from "@arcasync/shared";
import { BROWSER_ID_KEY, type KeyValue } from "./session";

type Platform = DeviceInfo["platform"];

/** `navigator.userAgentData.platform` when present, otherwise the user agent string. */
export function platformFrom(userAgent: string, hintPlatform?: string): Platform {
	const text = `${hintPlatform ?? ""} ${userAgent}`.toLowerCase();
	if (/android/.test(text)) return "android";
	if (/iphone|ipad|ipod|\bios\b/.test(text)) return "ios";
	if (/mac ?os|macintosh|mac os x/.test(text)) return "macos";
	if (/windows/.test(text)) return "windows";
	if (/linux|cros|x11/.test(text)) return "linux";
	return "unknown";
}

/** Order matters: Edge and Chrome both say "Chrome", every browser says "Safari". */
export function browserName(userAgent: string): string {
	if (/Edg\//.test(userAgent)) return "Edge";
	if (/Firefox\//.test(userAgent)) return "Firefox";
	if (/Chrome\/|CriOS\//.test(userAgent)) return "Chrome";
	if (/Safari\//.test(userAgent)) return "Safari";
	return "Browser";
}

/** `web-<uuid>`, created once per browser and reused, so one browser is one device row. */
export function browserId(storage: KeyValue, uuid: () => string): string {
	const existing = storage.getItem(BROWSER_ID_KEY);
	if (existing && /^web-[A-Za-z0-9-]{8,90}$/.test(existing)) return existing;
	const id = `web-${uuid()}`;
	storage.setItem(BROWSER_ID_KEY, id);
	return id;
}

export interface NavigatorLike {
	userAgent: string;
	userAgentData?: { platform?: string };
}

/** The `DeviceInfo` a browser signs in with. */
export function browserDevice(
	nav: NavigatorLike,
	storage: KeyValue,
	uuid: () => string,
): DeviceInfo {
	return {
		name: `Browser · ${browserName(nav.userAgent)}`.slice(0, 100),
		platform: platformFrom(nav.userAgent, nav.userAgentData?.platform),
		vaultId: browserId(storage, uuid),
	};
}

const PLATFORM_LABELS: Record<string, string> = {
	macos: "macOS",
	windows: "Windows",
	linux: "Linux",
	ios: "iOS",
	android: "Android",
};

export function platformLabel(platform: string): string {
	return PLATFORM_LABELS[platform] ?? "unknown platform";
}
