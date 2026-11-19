import { type App, PluginSettingTab } from "obsidian";
import type ArcaSyncPlugin from "../main";
import Settings from "./components/Settings.svelte";
import type { SettingsViewProps } from "./components/settingsProps";
import { type MountedComponent, mountComponent } from "./svelteHost";

export class ArcaSyncSettingsTab extends PluginSettingTab {
	private mounted: MountedComponent<SettingsViewProps> | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(
		app: App,
		private readonly plugin: ArcaSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		this.teardown();
		this.containerEl.empty();
		this.mounted = mountComponent<SettingsViewProps>(Settings, {
			target: this.containerEl,
			props: this.props(),
		});
		this.unsubscribe = this.plugin.onViewChange(() => this.mounted?.set(this.props()));
		// The server's feature flags decide whether the dev-login field renders.
		void this.plugin.refreshServerInfo();
		void this.plugin.refreshWorkspaces();
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

	private props(): SettingsViewProps {
		const view = this.plugin.viewModel();
		return {
			...view,
			onServerUrlChange: (value) => {
				void this.plugin.setServerUrl(value);
			},
			onDevLoginNameChange: (value) => {
				void this.plugin.updateSettings({ devLoginName: value });
			},
			onMappingAdd: (path, workspaceId) => {
				void this.plugin.addMapping(path, workspaceId);
			},
			onMappingChange: (index, patch) => {
				void this.plugin.updateMapping(index, patch);
			},
			onMappingRemove: (path) => {
				void this.plugin.removeMapping(path);
			},
			onWorkspaceChange: (workspaceId) => {
				void this.plugin.setWorkspace(workspaceId);
			},
			onFolderInputMount: (input, onPick) => this.plugin.attachFolderSuggest(input, onPick),
			onJoinInvite: (link, name, password, confirm) => {
				void this.plugin.joinWithInvite(link, name, password, confirm);
			},
			onPasswordSignIn: (name, password) => {
				void this.plugin.signInWithPassword(name, password);
			},
			onSetPassword: () => this.plugin.setPassword(),
			onDeviceSignIn: () => this.plugin.signInWithDevice(),
			onApproveDevice: () => this.plugin.approveDevice(),
			onConnect: () => {
				void this.plugin.connect();
			},
			onDisconnect: () => {
				this.plugin.disconnect();
			},
			onSignOut: () => {
				void this.plugin.signOut();
			},
		};
	}
}
