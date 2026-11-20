<script lang="ts">
import type { Role } from "@arcasync/shared";
import { untrack } from "svelte";
import {
	expiresIn,
	type MemberView,
	openInvites,
	openPins,
	ROLE_LABEL,
	type TeamView,
	teamPermissions,
} from "../settings/model";
import Breadcrumbs from "./Breadcrumbs.svelte";
import Callout from "./Callout.svelte";
import { icon } from "./icon";
import SettingItem from "./SettingItem.svelte";
import type { InvitesView, SettingsViewProps } from "./settingsProps";
import StatePill from "./StatePill.svelte";
import UserAvatar from "./UserAvatar.svelte";

const { v, team }: { v: SettingsViewProps; team: TeamView } = $props();
const ctl = $derived(v.ctl);
const teamId = $derived(team.id);
const can = $derived(teamPermissions(team, v.user?.isAdmin ?? false));
const roles: Role[] = ["viewer", "editor", "owner"];

let members = $state<MemberView[] | null>(null);
let invites = $state<InvitesView | null>(null);
let editing = $state(false);
let inviteRole = $state<Role>("editor");
let link = $state<string | null>(null);
let now = $state(Date.now());

async function loadMembers() {
	const id = teamId;
	const list = await ctl.loadMembers(untrack(() => team));
	if (id === teamId) members = list;
}

async function loadInvites() {
	if (!untrack(() => can.invite)) return;
	const id = teamId;
	const list = await ctl.loadInvites(untrack(() => team));
	if (id !== teamId) return;
	invites = list;
	now = Date.now();
}

$effect(() => {
	// Reload only when another team is shown, not on every status change.
	teamId;
	untrack(() => {
		members = null;
		invites = null;
		link = null;
		editing = false;
		void loadMembers();
		void loadInvites();
	});
});

async function rename(value: string) {
	const name = value.trim();
	if (name && name !== team.name) await ctl.renameTeam(team.id, name);
}

async function changeRole(member: MemberView, role: Role) {
	await ctl.setRole(team, member.id, role);
	await loadMembers();
}

async function remove(member: MemberView) {
	if (await ctl.removeMember(team, member)) {
		await loadMembers();
		ctl.refreshTeams();
	}
}

async function createLink() {
	link = await ctl.createInviteLink(team, inviteRole);
	if (link) ctl.copy(link, "invite link");
	await loadInvites();
}

async function createPin() {
	const pin = await ctl.createPin(team, inviteRole);
	if (pin) ctl.copy(pin.pin, "PIN");
	await loadInvites();
}

function mappedPath(folderId: string) {
	return v.folders.find((f) => f.workspaceId === folderId) ?? null;
}

const activeInvites = $derived(invites ? openInvites(invites.invites, now) : []);
const activePins = $derived(invites?.pins ? openPins(invites.pins, now) : []);
</script>

<Breadcrumbs
	items={[{ label: "ArcaSync", onclick: () => ctl.back() }, { label: team.name }]}
	onback={() => ctl.back()}
/>

{#if can.rename}
	<SettingItem name="Name">
		<input
			type="text"
			class="arcasync-team-name"
			spellcheck="false"
			value={team.name}
			onchange={(event) => void rename(event.currentTarget.value)}
		/>
	</SettingItem>
{/if}

<SettingItem name={team.legacy ? "Folder" : "Shared folders"} heading>
	{#if can.shareFolder}
		<button class="arcasync-share-folder" onclick={() => ctl.shareLocalFolder(team)}>
			Share a local folder
		</button>
	{/if}
</SettingItem>
{#each team.folders as folder (folder.id)}
	{@const mapped = mappedPath(folder.id)}
	<SettingItem
		name={folder.name}
		description={mapped ? `In this vault: ${mapped.path}` : "Not in this vault"}
		cls="arcasync-team-folder"
	>
		{#snippet lead()}
			<span class="arcasync-folder-icon" use:icon={mapped ? "folder-sync" : "folder"}></span>
		{/snippet}
		{#if mapped}
			<StatePill state={mapped.state} />
		{:else}
			<button class="mod-cta arcasync-add-to-vault" onclick={() => ctl.addToVault(folder.id, folder.name)}>
				Add to this vault
			</button>
		{/if}
		<button
			class="clickable-icon"
			aria-label="More"
			use:icon={"more-horizontal"}
			onclick={(event) => ctl.folderMenu(event, team, folder)}
		></button>
	</SettingItem>
{:else}
	<Callout title="No shared folders yet" icon="folder">
		{can.shareFolder
			? "Share a local folder to start syncing it with the team."
			: "The team's owners have not shared a folder yet."}
	</Callout>
{/each}

<SettingItem name="Members" heading>
	{#if can.manageMembers && members && members.length > 1}
		<button class="arcasync-members-edit" onclick={() => (editing = !editing)}>
			{editing ? "Done" : "Edit"}
		</button>
	{/if}
</SettingItem>
{#if members === null}
	<div class="arcasync-loading">Loading…</div>
{:else}
	{#each members as member (member.id)}
		{@const self = member.id === v.user?.id}
		<SettingItem
			name={self ? `${member.name} (you)` : member.name}
			description={member.email ?? ""}
			cls="arcasync-member"
		>
			{#snippet lead()}
				<UserAvatar name={member.name} color={member.color} avatarUrl={member.avatarUrl} />
			{/snippet}
			{#if editing && !self}
				<select
					class="dropdown arcasync-member-role"
					value={member.role}
					onchange={(event) => void changeRole(member, event.currentTarget.value as Role)}
				>
					{#each roles as role (role)}
						<option value={role}>{ROLE_LABEL[role]}</option>
					{/each}
				</select>
				<button
					class="clickable-icon arcasync-member-remove"
					aria-label="Remove {member.name}"
					use:icon={"user-minus"}
					onclick={() => void remove(member)}
				></button>
			{:else}
				<span class="arcasync-role">{ROLE_LABEL[member.role]}</span>
			{/if}
		</SettingItem>
	{/each}
{/if}

{#if can.invite}
	<SettingItem name="Invite people" heading>
		<select class="dropdown arcasync-invite-role" bind:value={inviteRole} aria-label="Role">
			{#each roles as role (role)}
				<option value={role}>As {ROLE_LABEL[role].toLowerCase()}</option>
			{/each}
		</select>
	</SettingItem>
	<SettingItem name="Invite link" description="For up to 10 people, for 7 days.">
		<button class="arcasync-invite-create" onclick={() => void createLink()}>Create link</button>
	</SettingItem>
	{#if link}
		<SettingItem cls="arcasync-invite-result" description="Shown once. It is on your clipboard.">
			<input type="text" class="arcasync-invite-url" readonly value={link} />
			<button
				class="clickable-icon"
				aria-label="Copy"
				use:icon={"copy"}
				onclick={() => ctl.copy(link ?? "", "invite link")}
			></button>
		</SettingItem>
	{/if}
	{#if invites?.pins}
		<SettingItem name="PIN" description="For one person, typed in the plugin or on the website.">
			<button class="arcasync-pin-create" onclick={() => void createPin()}>Create PIN</button>
		</SettingItem>
		{#if invites.pinsLocked}
			<Callout title="PIN entry is locked" icon="lock">Too many wrong PINs were tried. It unlocks by itself, or a server admin can unlock it.</Callout>
		{/if}
	{/if}
	{#each activePins as pin (pin.id)}
		<SettingItem
			description="{ROLE_LABEL[pin.role]} · expires {expiresIn(pin.expiresAt, now)}"
			cls="arcasync-pin"
		>
			{#snippet nameSnippet()}<span class="arcasync-pin-value">{pin.pin}</span>{/snippet}
			<button
				class="clickable-icon"
				aria-label="Copy"
				use:icon={"copy"}
				onclick={() => ctl.copy(pin.pin, "PIN")}
			></button>
			<button
				class="clickable-icon"
				aria-label="Revoke"
				use:icon={"x"}
				onclick={async () => {
					await ctl.revokePin(team, pin.id);
					await loadInvites();
				}}
			></button>
		</SettingItem>
	{/each}
	{#each activeInvites as invite (invite.id)}
		<SettingItem
			name="Link · {ROLE_LABEL[invite.role]}"
			description="{invite.uses}/{invite.maxUses} used · expires {expiresIn(invite.expiresAt, now)}"
			cls="arcasync-open-invite"
		>
			<button
				class="clickable-icon"
				aria-label="Revoke"
				use:icon={"x"}
				onclick={async () => {
					await ctl.revokeInvite(team, invite.id);
					await loadInvites();
				}}
			></button>
		</SettingItem>
	{/each}
{/if}

<SettingItem name="Danger zone" heading />
<SettingItem name="Leave team" description="Its folders stop syncing here. Your files stay.">
	<button class="arcasync-leave-team" onclick={() => ctl.leaveTeam(team)}>Leave</button>
</SettingItem>
{#if can.deleteTeam}
	<SettingItem name="Delete team" description="Deletes its shared folders for everyone.">
		<button class="mod-warning arcasync-delete-team" onclick={() => ctl.deleteTeam(team)}>Delete</button>
	</SettingItem>
{/if}
