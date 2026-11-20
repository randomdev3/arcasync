/**
 * The `obsidian` module only exists inside the app (esbuild marks it external).
 * Vitest aliases it here so plugin modules can be imported in Node. Only the
 * surface the plugin actually touches is implemented.
 */
import { StateField } from "@codemirror/state";

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
	registerEditorExtension(_extension: unknown): void {}
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

export class TAbstractFile {
	vault: unknown = null;
	path = "";
	name = "";
	parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
	basename = "";
	extension = "";
	stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === "/";
	}
}

/** Obsidian's vault path normaliser: forward slashes, no duplicate/leading/trailing slashes. */
export function normalizePath(path: string): string {
	const p = path
		.replace(/[\\/]+/g, "/")
		.replace(/\u00A0|\u202F/g, " ")
		.replace(/^\/+|\/+$/g, "");
	return p === "" ? "/" : p.normalize("NFC");
}

export class MarkdownView {}

/** Obsidian's editor-info state field; never present in a test editor state. */
export const editorInfoField = StateField.define<unknown>({
	create: () => null,
	update: (value) => value,
});

export abstract class AbstractInputSuggest<T> {
	constructor(
		readonly app: unknown,
		readonly inputEl: HTMLInputElement,
	) {}
	abstract getSuggestions(query: string): T[] | Promise<T[]>;
	abstract renderSuggestion(value: T, el: HTMLElement): void;
	selectSuggestion(_value: T, _evt: MouseEvent | KeyboardEvent): void {}
	close(): void {}
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

export function setIcon(_el: HTMLElement, _icon: string): void {}
