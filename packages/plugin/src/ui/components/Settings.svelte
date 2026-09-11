<script lang="ts">
import type { Readable } from "svelte/store";
import type { SettingsViewProps } from "./settingsProps";

const { vm }: { vm: Readable<SettingsViewProps> } = $props();

const STATUS_LABEL = {
	connected: "Connected",
	connecting: "Connecting…",
	disconnected: "Not connected",
	error: "Error",
} as const;
</script>

<div class="teamsync-settings">
	<div class="teamsync-row">
		<div class="teamsync-row-info">
			<div class="teamsync-row-name">Server URL</div>
			<div class="teamsync-row-desc">Base URL of your TeamSync server.</div>
		</div>
		<input
			type="text"
			spellcheck="false"
			placeholder="http://localhost:8787"
			value={$vm.serverUrl}
			onchange={(event) => $vm.onServerUrlChange(event.currentTarget.value)}
		/>
	</div>

	{#if $vm.devOpenLogin}
		<div class="teamsync-row">
			<div class="teamsync-row-info">
				<div class="teamsync-row-name">Display name</div>
				<div class="teamsync-row-desc">
					This server allows open development login. Pick any name.
				</div>
			</div>
			<input
				type="text"
				spellcheck="false"
				placeholder="alice"
				value={$vm.devLoginName}
				onchange={(event) => $vm.onDevLoginNameChange(event.currentTarget.value)}
			/>
		</div>
	{/if}

	<div class="teamsync-row">
		<div class="teamsync-row-info">
			<div class="teamsync-row-name">Connection</div>
			<div class="teamsync-status" data-state={$vm.status}>
				{#if $vm.serverError}
					{$vm.serverError}
				{:else if $vm.statusMessage}
					{STATUS_LABEL[$vm.status]} — {$vm.statusMessage}
				{:else if $vm.signedInAs}
					{STATUS_LABEL[$vm.status]} as {$vm.signedInAs}{$vm.workspaceName
						? ` · ${$vm.workspaceName}`
						: ""}
				{:else}
					{STATUS_LABEL[$vm.status]}
				{/if}
			</div>
		</div>
		<div>
			{#if $vm.status === "disconnected" || $vm.status === "error"}
				<button class="mod-cta" disabled={$vm.busy} onclick={() => $vm.onConnect()}>
					Connect
				</button>
			{:else}
				<button disabled={$vm.busy} onclick={() => $vm.onDisconnect()}>Disconnect</button>
			{/if}
			{#if $vm.signedInAs}
				<button disabled={$vm.busy} onclick={() => $vm.onSignOut()}>Sign out</button>
			{/if}
		</div>
	</div>
</div>
