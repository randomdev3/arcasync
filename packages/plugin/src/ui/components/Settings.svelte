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

function folderSuggest(input: HTMLInputElement, onPick: (path: string) => void) {
	let pick = onPick;
	const destroy = $vm.onFolderInputMount(input, (path) => pick(path));
	return {
		update(next: (path: string) => void) {
			pick = next;
		},
		destroy,
	};
}

/** The blank row for a new mapping is open (it always is while nothing is mapped). */
let adding = $state(false);
let picked = $state("");
const unmapped = $derived(
	$vm.workspaces.filter((w) => !$vm.sharedFolders.some((f) => f.workspaceId === w.id)),
);
/** The new row's workspace: the one picked, else the primary if unmapped, else the first unmapped. */
const newWorkspace = $derived(
	unmapped.some((w) => w.id === picked)
		? picked
		: ((unmapped.find((w) => w.id === $vm.workspaceId) ?? unmapped[0])?.id ?? ""),
);

let inviteLink = $state("");
let inviteName = $state("");

function join() {
	if (!inviteLink.trim()) return;
	$vm.onJoinInvite(inviteLink, inviteName);
	inviteLink = "";
}

function addMapping(path: string) {
	if (!path.trim()) return;
	$vm.onMappingAdd(path, newWorkspace);
	adding = false;
}
</script>

<div class="arcasync-settings">
	<div class="arcasync-row">
		<div class="arcasync-row-info">
			<div class="arcasync-row-name">Server URL</div>
			<div class="arcasync-row-desc">Base URL of your ArcaSync server.</div>
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
		<div class="arcasync-row">
			<div class="arcasync-row-info">
				<div class="arcasync-row-name">Display name</div>
				<div class="arcasync-row-desc">
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

	{#if $vm.accounts}
		<div class="arcasync-row">
			<div class="arcasync-row-info">
				<div class="arcasync-row-name">
					{$vm.signedIn ? "Join another workspace" : "Join with an invite"}
				</div>
				<div class="arcasync-row-desc">Paste the invite link or code you were sent.</div>
			</div>
			<div class="arcasync-invite">
				<input
					type="text"
					class="arcasync-invite-input"
					spellcheck="false"
					placeholder="obsidian://arcasync?…"
					bind:value={inviteLink}
				/>
				{#if !$vm.signedIn}
					<input
						type="text"
						class="arcasync-invite-name"
						spellcheck="false"
						placeholder="Your name"
						bind:value={inviteName}
					/>
				{/if}
				<button class="mod-cta arcasync-invite-join" disabled={$vm.busy} onclick={join}>
					Join
				</button>
			</div>
		</div>

		<div class="arcasync-row">
			<div class="arcasync-row-info">
				{#if $vm.signedIn}
					<div class="arcasync-row-name">Approve a device</div>
					<div class="arcasync-row-desc">
						Let another device sign in as you with the code it shows.
					</div>
				{:else}
					<div class="arcasync-row-name">Sign in with another device</div>
					<div class="arcasync-row-desc">
						Get a code here and approve it on a device where you are signed in.
					</div>
				{/if}
			</div>
			{#if $vm.signedIn}
				<button class="arcasync-approve-device-open" onclick={() => $vm.onApproveDevice()}>
					Approve a device sign-in…
				</button>
			{:else}
				<button class="arcasync-device-signin" onclick={() => $vm.onDeviceSignIn()}>
					Sign in with another device
				</button>
			{/if}
		</div>
	{/if}

	<div class="arcasync-row">
		<div class="arcasync-row-info">
			<div class="arcasync-row-name">Shared folders</div>
			<div class="arcasync-row-desc">
				Each vault folder syncs with one workspace. Folders cannot be inside each other.
			</div>
		</div>
		<div class="arcasync-mappings">
			{#each $vm.sharedFolders as folder, index (folder.path)}
				<div class="arcasync-mapping">
					<input
						type="text"
						class="arcasync-shared-folder"
						spellcheck="false"
						value={folder.path}
						use:folderSuggest={(path) => $vm.onMappingChange(index, { path })}
						onchange={(event) => $vm.onMappingChange(index, { path: event.currentTarget.value })}
					/>
					{#if $vm.workspaces.length > 0}
						<select
							class="dropdown arcasync-workspace"
							disabled={$vm.busy}
							value={folder.workspaceId}
							onchange={(event) =>
								$vm.onMappingChange(index, { workspaceId: event.currentTarget.value })}
						>
							{#each $vm.workspaces as workspace (workspace.id)}
								<option value={workspace.id}>{workspace.name}</option>
							{/each}
						</select>
					{/if}
					<button class="arcasync-mapping-remove" onclick={() => $vm.onMappingRemove(folder.path)}>
						Remove
					</button>
				</div>
			{/each}
			{#if adding || $vm.sharedFolders.length === 0}
				<div class="arcasync-mapping">
					<input
						type="text"
						class="arcasync-shared-folder arcasync-new-folder"
						spellcheck="false"
						placeholder="Shared"
						use:folderSuggest={addMapping}
						onchange={(event) => addMapping(event.currentTarget.value)}
					/>
					{#if unmapped.length > 0}
						<select
							class="dropdown arcasync-workspace"
							disabled={$vm.busy}
							value={newWorkspace}
							onchange={(event) => {
								picked = event.currentTarget.value;
							}}
						>
							{#each unmapped as workspace (workspace.id)}
								<option value={workspace.id}>{workspace.name}</option>
							{/each}
						</select>
					{/if}
				</div>
			{:else if unmapped.length > 0}
				<button class="arcasync-mapping-add" onclick={() => (adding = true)}>Add folder</button>
			{/if}
		</div>
	</div>

	{#if $vm.workspaces.length > 1}
		<div class="arcasync-row">
			<div class="arcasync-row-info">
				<div class="arcasync-row-name">Primary workspace</div>
				<div class="arcasync-row-desc">
					Named first in the status bar, and connected when no folder is mapped.
				</div>
			</div>
			<select
				class="dropdown arcasync-primary-workspace"
				disabled={$vm.busy}
				value={$vm.workspaceId}
				onchange={(event) => $vm.onWorkspaceChange(event.currentTarget.value)}
			>
				{#each $vm.workspaces as workspace (workspace.id)}
					<option value={workspace.id}>{workspace.name}</option>
				{/each}
			</select>
		</div>
	{/if}

	<div class="arcasync-row">
		<div class="arcasync-row-info">
			<div class="arcasync-row-name">Connection</div>
			<div class="arcasync-status" data-state={$vm.status}>
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
