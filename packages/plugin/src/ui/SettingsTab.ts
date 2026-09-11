import { type App, PluginSettingTab } from "obsidian";
import type TeamSyncPlugin from "../main";
import Settings from "./components/Settings.svelte";
import type { SettingsViewProps } from "./components/settingsProps";
import { type MountedComponent, mountComponent } from "./svelteHost";

export class TeamSyncSettingsTab extends PluginSettingTab {
	private mounted: MountedComponent<SettingsViewProps> | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(
		app: App,
		private readonly plugin: TeamSyncPlugin,
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
