<script lang="ts">
import SettingItem from "./SettingItem.svelte";
import type { SettingsViewProps } from "./settingsProps";

const { v }: { v: SettingsViewProps } = $props();
const ctl = $derived(v.ctl);
const custom = $derived(v.serverUrl !== v.defaultServerUrl);
</script>

<details class="arcasync-self-hosting" open={custom || undefined}>
	<summary class="setting-item setting-item-heading">
		<div class="setting-item-info"><div class="setting-item-name">Self-hosting</div></div>
	</summary>
	<SettingItem
		name="Server"
		description={v.signedIn ? "Changing it signs you out." : "Your own ArcaSync relay, or the hosted one."}
	>
		<input
			type="text"
			class="arcasync-server-url"
			spellcheck="false"
			placeholder={v.defaultServerUrl}
			value={v.serverUrl}
			onchange={(event) => ctl.setServerUrl(event.currentTarget.value)}
		/>
		{#if custom}
			<button onclick={() => ctl.setServerUrl(v.defaultServerUrl)}>Use hosted</button>
		{/if}
	</SettingItem>
	<SettingItem
		name="Status"
		description={v.serverError ?? (v.serverVersion ? `Reachable · version ${v.serverVersion}` : "Checking…")}
		cls={v.serverError ? "arcasync-server-error" : ""}
	/>
	{#if v.devOpenLogin}
		<SettingItem name="Display name" description="This server allows open development login.">
			<input
				type="text"
				spellcheck="false"
				placeholder="alice"
				value={v.devLoginName}
				onchange={(event) => ctl.setDevLoginName(event.currentTarget.value)}
			/>
			{#if !v.signedIn}
				<button class="mod-cta" disabled={v.busy || !v.devLoginName} onclick={() => ctl.connect()}>
					Connect
				</button>
			{/if}
		</SettingItem>
	{/if}
</details>
