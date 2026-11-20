<script lang="ts">
import { ROLE_LABEL, type TeamView } from "../settings/model";
import Callout from "./Callout.svelte";
import { icon } from "./icon";
import SettingItem from "./SettingItem.svelte";
import type { SettingsViewProps } from "./settingsProps";
import StatePill from "./StatePill.svelte";
import UserAvatar from "./UserAvatar.svelte";

const { v }: { v: SettingsViewProps } = $props();
const ctl = $derived(v.ctl);

let invite = $state("");
let joining = $state(false);

async function join() {
	if (joining || !invite.trim()) return;
	joining = true;
	try {
		if (await ctl.join(invite, "", "", "")) invite = "";
	} finally {
		joining = false;
	}
}

function teamDescription(team: TeamView): string {
	const parts = [ROLE_LABEL[team.role]];
	if (team.memberCount !== null) {
		parts.push(team.memberCount === 1 ? "1 member" : `${team.memberCount} members`);
	}
	if (!team.legacy) {
		parts.push(team.folders.length === 1 ? "1 folder" : `${team.folders.length} folders`);
	}
	return parts.join(" · ");
}

const connected = $derived(v.status === "connected" || v.status === "connecting");
</script>

{#if v.user}
	<SettingItem name={v.user.name} description={v.user.email ?? "Signed in"} cls="arcasync-account">
		{#snippet lead()}
			<UserAvatar name={v.user?.name ?? ""} color={v.user?.color ?? "var(--interactive-accent)"} avatarUrl={v.user?.avatarUrl} size={36} />
		{/snippet}
		<button onclick={() => ctl.signOut()}>Sign out</button>
	</SettingItem>
{/if}
{#if v.passwords}
	<SettingItem
		name="Password"
		description={v.hasPassword ? "Changing it signs your other devices out." : "Lets you sign in on other devices with your name."}
	>
		<button class="arcasync-password-open" onclick={() => ctl.setPassword()}>
			{v.hasPassword ? "Change…" : "Set…"}
		</button>
	</SettingItem>
{/if}
{#if v.accounts}
	<SettingItem name="Approve a device" description="Let another device sign in as you with its code.">
		<button class="arcasync-approve-device-open" onclick={() => ctl.approveDevice()}>Approve…</button>
	</SettingItem>
{/if}

<SettingItem name="Teams" heading>
	{#if v.teamsFeature}
		<button class="arcasync-create-team" onclick={() => ctl.createTeam()}>Create team</button>
	{/if}
</SettingItem>
{#each v.teams as team (team.id)}
	<SettingItem
		name={team.name}
		description={teamDescription(team)}
		cls="arcasync-team"
		onclick={() => ctl.navigate({ kind: "team", teamId: team.id })}
	>
		<button
			class="clickable-icon"
			aria-label="Team settings"
			use:icon={"settings"}
			onclick={() => ctl.navigate({ kind: "team", teamId: team.id })}
		></button>
	</SettingItem>
{:else}
	<Callout title="No teams yet" icon="users">
		{v.teamsFeature
			? "Create a team to share folders, or join one with an invite link or PIN."
			: "Join a workspace with an invite link or PIN."}
	</Callout>
{/each}
<SettingItem name="Join a team" description={v.pins ? "Invite link or PIN." : "Invite link."}>
	<input
		type="text"
		class="arcasync-invite-input"
		spellcheck="false"
		placeholder={v.pins ? "Link or PIN" : "Invite link"}
		bind:value={invite}
		onkeydown={(event) => {
			if (event.key === "Enter") void join();
		}}
	/>
	<button class="arcasync-invite-join" disabled={joining || !invite.trim()} onclick={() => void join()}>
		Join
	</button>
</SettingItem>

<SettingItem name="This vault" heading>
	{#if v.folders.length > 0}
		{#if connected}
			<button onclick={() => ctl.disconnect()}>Disconnect</button>
		{:else}
			<button class="mod-cta" disabled={v.busy} onclick={() => ctl.connect()}>Connect</button>
		{/if}
	{/if}
</SettingItem>
{#if v.statusMessage && v.status === "error"}
	<div class="arcasync-error-line">{v.statusMessage}</div>
{/if}
{#each v.folders as folder (folder.path)}
	<SettingItem
		name={folder.path}
		description={folder.teamName
			? folder.folderName && folder.folderName !== folder.teamName
				? `${folder.teamName} · ${folder.folderName}`
				: folder.teamName
			: "Not in any of your teams"}
		cls="arcasync-mapping"
		onclick={folder.teamId ? () => ctl.navigate({ kind: "team", teamId: folder.teamId ?? "" }) : undefined}
	>
		{#snippet lead()}
			<span class="arcasync-folder-icon" use:icon={"folder"}></span>
		{/snippet}
		<StatePill state={folder.state} />
		{#if folder.teamId}
			<button
				class="clickable-icon"
				aria-label="Team settings"
				use:icon={"settings"}
				onclick={() => ctl.navigate({ kind: "team", teamId: folder.teamId ?? "" })}
			></button>
		{/if}
	</SettingItem>
{:else}
	<Callout title="Nothing syncs here yet" icon="folder-sync">
		Open a team and choose <b>Add to this vault</b>, or right-click a folder and choose
		<b>Share with team…</b>
	</Callout>
{/each}
