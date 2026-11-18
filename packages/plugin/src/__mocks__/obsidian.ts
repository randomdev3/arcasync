/**
 * The `obsidian` module only exists inside the app (esbuild marks it external).
 * Vitest aliases it here so plugin modules can be imported in Node. Only the
 * surface the plugin actually touches is implemented.
 */

export class Notice {
	static messages: string[] = [];
	constructor(readonly message: string) {
		Notice.messages.push(message);
	}
	hide(): void {}
}

export class Events {
	on(): void {}
	off(): void {}
}

export class Component {
	load(): void {}
	unload(): void {}
	register(): void {}
	registerEvent(): void {}
}

export class Plugin extends Component {
	constructor(
		readonly app: unknown,
		readonly manifest: unknown,
	) {
		super();
	}
	addCommand(command: unknown): unknown {
		return command;
	}
	addSettingTab(): void {}
	addStatusBarItem(): HTMLElement {
		throw new Error("addStatusBarItem is not available outside Obsidian");
	}
	async loadData(): Promise<unknown> {
		return null;
	}
	async saveData(): Promise<void> {}
}

export class PluginSettingTab {
	containerEl: HTMLElement = null as unknown as HTMLElement;
	constructor(
		readonly app: unknown,
		readonly plugin: unknown,
	) {}
	display(): void {}
	hide(): void {}
}

export const Platform = {
	isMacOS: true,
	isWin: false,
	isLinux: false,
	isIosApp: false,
	isAndroidApp: false,
	isMobile: false,
	isDesktopApp: true,
};

export interface RequestUrlParam {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: unknown;
	text: string;
}

/** Tests replace `requestUrlMock.impl` to stub responses. */
export const requestUrlMock = {
	impl: async (_param: RequestUrlParam): Promise<RequestUrlResponse> => ({
		status: 200,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
		json: {},
		text: "{}",
	}),
};

export function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
	return requestUrlMock.impl(param);
}

export type App = unknown;
