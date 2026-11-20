import { type App, PluginSettingTab } from "obsidian";
import type ArcaSyncPlugin from "../main";
import SettingsApp from "./components/SettingsApp.svelte";
import type { SettingsController, SettingsViewProps } from "./components/settingsProps";
import {
	back,
	initialStack,
	openAt,
	type Page,
	type PageStack,
	push,
	resolve,
} from "./settings/router";
import { type MountedComponent, mountComponent } from "./svelteHost";

/** ArcaSync's settings: a stack of Svelte pages built from Obsidian's own setting rows. */
export class ArcaSyncSettingsTab extends PluginSettingTab {
	private mounted: MountedComponent<SettingsViewProps> | null = null;
	private unsubscribe: (() => void) | null = null;
	private stack: PageStack;
	/** Shown by the next `display()` (a file menu's "Team settings"). */
	private nextPage: Page | null = null;
	private readonly ctl: SettingsController;

	constructor(
		app: App,
		private readonly plugin: ArcaSyncPlugin,
	) {
		super(app, plugin);
		this.stack = initialStack(plugin.signedIn);
		this.ctl = this.controller();
	}

	/** The page the tab opens on next time it is shown. */
	showNext(page: Page | null): void {
		this.nextPage = page;
		if (this.mounted && page) this.navigate(page);
	}

	navigate(page: Page): void {
		this.stack = push(this.stack, page);
		this.render();
		this.scrollTop();
	}

	display(): void {
		this.teardown();
		this.containerEl.empty();
		this.containerEl.addClass("arcasync-settings-tab");
		const signedIn = this.plugin.signedIn;
		this.stack = this.nextPage ? openAt(this.nextPage, signedIn) : initialStack(signedIn);
		this.nextPage = null;
		this.mounted = mountComponent<SettingsViewProps>(SettingsApp, {
			target: this.containerEl,
			props: this.props(),
		});
		this.unsubscribe = this.plugin.onViewChange(() => this.render());
		void this.plugin.refreshServerInfo();
		void this.plugin.refreshMe();
		void this.plugin.refreshTeams();
	}

	hide(): void {
		this.teardown();
		this.containerEl.empty();
	}

	private teardown(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.mounted?.destroy();
		this.mounted = null;
	}

	private render(): void {
		this.mounted?.set(this.props());
	}

	private scrollTop(): void {
		this.containerEl.scrollTop = 0;
	}

	private props(): SettingsViewProps {
		const view = this.plugin.viewModel();
		this.stack = resolve(this.stack, {
			signedIn: view.signedIn,
			teamIds: view.signedIn ? new Set(view.teams.map((t) => t.id)) : null,
		});
		return {
			...view,
			page: this.stack.current,
			canGoBack: this.stack.history.length > 0,
			ctl: this.ctl,
		};
	}

	private controller(): SettingsController {
		const plugin = this.plugin;
		return {
			navigate: (page) => this.navigate(page),
			back: () => {
				this.stack = back(this.stack, plugin.signedIn);
				this.render();
			},
			startBrowserSignIn: (provider) => plugin.startBrowserSignIn(provider),
			reopenBrowserSignIn: () => plugin.reopenBrowserSignIn(),
			cancelBrowserSignIn: () => plugin.cancelBrowserSignIn(),
			passwordSignIn: (name, password) => plugin.signInWithPassword(name, password),
			join: (input, name, password, confirm) =>
				plugin.joinWithInvite(input, name, password, confirm),
			deviceSignIn: () => plugin.signInWithDevice(),
			signOut: () => void plugin.signOut(),
			setPassword: () => plugin.setPassword(),
			approveDevice: () => plugin.approveDevice(),
			connect: () => void plugin.connect(),
			disconnect: () => plugin.disconnect(),
			refreshTeams: () => void plugin.refreshTeams(),
			createTeam: () => plugin.createTeam(),
			renameTeam: (teamId, name) => plugin.renameTeam(teamId, name),
			deleteTeam: (team) => void plugin.deleteTeam(team),
			leaveTeam: (team) => void plugin.leaveTeam(team),
			loadMembers: (team) => plugin.loadMembers(team),
			setRole: (team, userId, role) => plugin.setMemberRole(team, userId, role),
			removeMember: (team, member) => plugin.removeTeamMember(team, member),
			loadInvites: (team) => plugin.loadInvites(team),
			createInviteLink: (team, role) => plugin.createInviteLink(team, role),
			createPin: (team, role) => plugin.createTeamPin(team, role),
			revokeInvite: (team, id) => plugin.revokeTeamInvite(team, id),
			revokePin: (team, id) => plugin.revokeTeamPin(team, id),
			copy: (text, what) => plugin.copy(text, what),
			addToVault: (workspaceId, name) => plugin.addToVault(workspaceId, name),
			shareLocalFolder: (team) => plugin.shareLocalFolder(team),
			folderMenu: (event, team, folder) => plugin.folderMenu(event, team, folder),
			setServerUrl: (value) => void plugin.setServerUrl(value),
			setDevLoginName: (value) => void plugin.updateSettings({ devLoginName: value }),
			refreshServer: () => {
				void plugin.refreshServerInfo().then(() => plugin.refreshTeams());
			},
		};
	}
}
