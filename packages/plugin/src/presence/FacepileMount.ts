import { type App, type EventRef, MarkdownView } from "obsidian";
import Facepile from "../ui/components/Facepile.svelte";
import { type MountedComponent, mountComponent } from "../ui/svelteHost";
import { showUserMenu } from "../ui/userPicker";
import { toWs } from "../workspace/paths";
import type { IPresence } from "../workspace/types";
import { type AvatarModel, avatarsFor } from "./avatars";
import type { Navigator } from "./Navigator";

type FacepileProps = {
	avatars: AvatarModel[];
	following: string | null;
	onselect: (userId: string, follow: boolean) => void;
	onmenu: (userId: string, event: MouseEvent) => void;
};

interface Mounted {
	/** `display: contents` wrapper in the view header that the component renders into. */
	host: HTMLElement;
	component: MountedComponent<FacepileProps>;
}

function unmount({ host, component }: Mounted): void {
	component.destroy();
	host.remove();
}

/**
 * Keeps a facepile in the header of every open `MarkdownView`: other present users, `here` on
 * that note, dimmed when `elsewhere` or `idle`. Views are picked up on `layout-change`; avatars
 * re-render on presence changes and when a view switches notes.
 *
 * With a navigator, an avatar click jumps to that user, Shift-click follows them and the context
 * menu offers both; the followed user's avatar is ringed.
 */
export class FacepileMount {
	private readonly mounted = new Map<MarkdownView, Mounted>();
	private readonly refs: EventRef[] = [];
	private renameRef: EventRef | null = null;
	private offPresence: (() => void) | null = null;
	private offNavigator: (() => void) | null = null;
	private readonly onselect = (userId: string, follow: boolean) => {
		const navigator = this.navigator;
		if (!navigator) return;
		if (follow) navigator.follow(userId);
		else void navigator.jumpTo(userId);
	};
	private readonly onmenu = (userId: string, event: MouseEvent) => {
		const navigator = this.navigator;
		const devices = this.presence.users().get(userId);
		const name = devices?.[0]?.user.name;
		if (!navigator || !name) return;
		showUserMenu(
			event,
			{ name, followed: navigator.following === userId },
			{
				jump: () => void navigator.jumpTo(userId),
				follow: () => navigator.follow(userId),
				unfollow: () => navigator.unfollow(),
			},
		);
	};

	constructor(
		private readonly app: App,
		private readonly presence: IPresence,
		private readonly selfId: string,
		private readonly root: string | null,
		private readonly navigator: Navigator | null = null,
	) {}

	start(): void {
		const refresh = () => this.refresh();
		const { workspace, vault } = this.app;
		this.refs.push(
			workspace.on("layout-change", refresh),
			workspace.on("file-open", refresh),
			workspace.on("active-leaf-change", refresh),
		);
		this.renameRef = vault.on("rename", refresh);
		this.offPresence = this.presence.onChange(refresh);
		this.offNavigator = this.navigator?.onChange(refresh) ?? null;
		workspace.onLayoutReady(refresh);
	}

	stop(): void {
		for (const ref of this.refs.splice(0)) this.app.workspace.offref(ref);
		if (this.renameRef) this.app.vault.offref(this.renameRef);
		this.renameRef = null;
		this.offPresence?.();
		this.offPresence = null;
		this.offNavigator?.();
		this.offNavigator = null;
		for (const mounted of this.mounted.values()) unmount(mounted);
		this.mounted.clear();
	}

	private refresh(): void {
		if (this.offPresence === null) return;
		const users = this.presence.users();
		const following = this.navigator?.following ?? null;
		const seen = new Set<MarkdownView>();
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			// A deferred (not yet loaded) leaf has a placeholder view without a header.
			if (!(view instanceof MarkdownView)) continue;
			const header = view.containerEl.querySelector(".view-header");
			if (!header) continue;
			seen.add(view);
			const path = view.file?.path ?? null;
			const file = path !== null && this.root !== null ? toWs(this.root, path) : null;
			const avatars = file === null ? [] : avatarsFor(users, this.selfId, file, this.root);
			const current = this.mounted.get(view);
			if (current && current.host.parentElement === header) {
				current.component.set({ avatars, following });
				continue;
			}
			if (current) unmount(current);
			const host = header.ownerDocument.createElement("div");
			host.className = "arcasync-facepile-host";
			host.style.display = "contents";
			header.insertBefore(host, header.querySelector(".view-actions"));
			const component = mountComponent<FacepileProps>(Facepile, {
				target: host,
				props: { avatars, following, onselect: this.onselect, onmenu: this.onmenu },
			});
			this.mounted.set(view, { host, component });
		}
		for (const [view, mounted] of this.mounted) {
			if (seen.has(view)) continue;
			unmount(mounted);
			this.mounted.delete(view);
		}
	}
}
