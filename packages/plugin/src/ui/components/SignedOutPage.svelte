<script lang="ts">
import { parsePin } from "../../auth/invites";
import { PROVIDER_LABEL } from "../settings/model";
import Breadcrumbs from "./Breadcrumbs.svelte";
import { icon } from "./icon";
import SettingItem from "./SettingItem.svelte";
import type { SettingsViewProps } from "./settingsProps";

const { v }: { v: SettingsViewProps } = $props();
const ctl = $derived(v.ctl);
const pending = $derived(v.browserSignIn);

let signInName = $state("");
let signInPassword = $state("");
let signingIn = $state(false);

async function signIn() {
	if (signingIn || !signInName.trim() || !signInPassword) return;
	signingIn = true;
	try {
		if (await ctl.passwordSignIn(signInName, signInPassword)) signInPassword = "";
	} finally {
		signingIn = false;
	}
}

let invite = $state("");
let inviteName = $state("");
let invitePassword = $state("");
let inviteConfirm = $state("");
let joining = $state(false);
/** A PIN makes a password account, so it needs a password too. */
const isPin = $derived(v.pins && parsePin(invite) !== null);

async function join() {
	if (joining || !invite.trim()) return;
	joining = true;
	try {
		if (await ctl.join(invite, inviteName, invitePassword, inviteConfirm)) {
			invite = "";
			invitePassword = "";
			inviteConfirm = "";
		}
	} finally {
		joining = false;
	}
}

const crumbs = $derived([
	{ label: "ArcaSync", onclick: () => ctl.back() },
	{ label: v.page.kind === "join" ? "Join a team" : "Sign in" },
]);
</script>

{#if v.page.kind === "welcome"}
	<div class="arcasync-welcome">
		<div class="arcasync-welcome-mark" use:icon={"users"}></div>
		<div class="arcasync-welcome-title">ArcaSync</div>
		<div class="arcasync-welcome-tagline">Edit notes with your team, live.</div>

		{#if pending}
			<div class="arcasync-browser-pending">
				{#if pending.error}
					<div class="arcasync-browser-title mod-warning">{pending.error}</div>
				{:else}
					<div class="arcasync-browser-title">Continue in your browser…</div>
					<div class="setting-item-description">
						Sign in with {PROVIDER_LABEL[pending.provider]}, then approve
						{#if pending.userCode}<code class="arcasync-user-code-inline">{pending.userCode}</code>{:else}this device{/if}.
					</div>
				{/if}
				<div class="arcasync-browser-actions">
					<button class="mod-cta" onclick={() => ctl.reopenBrowserSignIn()}>
						{pending.error ? "Try again" : "Open browser again"}
					</button>
					<button onclick={() => ctl.cancelBrowserSignIn()}>Cancel</button>
				</div>
			</div>
		{:else if v.providers.length > 0}
			<div class="arcasync-providers">
				{#each v.providers as provider (provider)}
					<button
						class="arcasync-provider mod-cta"
						data-provider={provider}
						disabled={v.busy}
						onclick={() => ctl.startBrowserSignIn(provider)}
					>
						Continue with {PROVIDER_LABEL[provider]}
					</button>
				{/each}
			</div>
		{/if}
	</div>

	{#if v.passwords}
		<SettingItem
			name="Sign in with name and password"
			cls="arcasync-open-password"
			onclick={() => ctl.navigate({ kind: "password" })}
		>
			<span class="arcasync-chevron" use:icon={"chevron-right"}></span>
		</SettingItem>
	{/if}
	{#if v.accounts}
		<SettingItem
			name="Have an invite link or PIN?"
			cls="arcasync-open-join"
			onclick={() => ctl.navigate({ kind: "join" })}
		>
			<span class="arcasync-chevron" use:icon={"chevron-right"}></span>
		</SettingItem>
		<SettingItem
			name="Sign in with another device"
			description="Approve a code from a device where you are signed in."
		>
			<button class="arcasync-device-signin" onclick={() => ctl.deviceSignIn()}>Get a code</button>
		</SettingItem>
	{/if}
{:else}
	<Breadcrumbs items={crumbs} onback={() => ctl.back()} />

	{#if v.page.kind === "password"}
		<SettingItem name="Name">
			<input
				type="text"
				class="arcasync-signin-name"
				spellcheck="false"
				autocomplete="username"
				bind:value={signInName}
			/>
		</SettingItem>
		<SettingItem name="Password">
			<input
				type="password"
				class="arcasync-signin-password"
				autocomplete="current-password"
				bind:value={signInPassword}
				onkeydown={(event) => {
					if (event.key === "Enter") void signIn();
				}}
			/>
		</SettingItem>
		<SettingItem>
			<button
				class="mod-cta arcasync-signin-submit"
				disabled={signingIn || v.busy}
				onclick={() => void signIn()}
			>
				Sign in
			</button>
		</SettingItem>
	{:else}
		<SettingItem
			name="Invite link or PIN"
			description={v.pins ? "Paste the link, or type the PIN you were given." : "Paste the link you were sent."}
		>
			<input
				type="text"
				class="arcasync-invite-input"
				spellcheck="false"
				placeholder={v.pins ? "https://…/join?invite=… or 123456" : "https://…/join?invite=…"}
				bind:value={invite}
			/>
		</SettingItem>
		<SettingItem name="Your name" description="Shown to your teammates.">
			<input
				type="text"
				class="arcasync-invite-name"
				spellcheck="false"
				autocomplete="username"
				bind:value={inviteName}
			/>
		</SettingItem>
		{#if isPin}
			<SettingItem name="Password" description="At least 10 characters. You sign in with your name and it.">
				<input
					type="password"
					class="arcasync-invite-password"
					autocomplete="new-password"
					bind:value={invitePassword}
				/>
			</SettingItem>
			<SettingItem name="Repeat password">
				<input
					type="password"
					class="arcasync-invite-password-confirm"
					autocomplete="new-password"
					bind:value={inviteConfirm}
				/>
			</SettingItem>
		{/if}
		<SettingItem>
			<button
				class="mod-cta arcasync-invite-join"
				disabled={joining || v.busy}
				onclick={() => void join()}
			>
				Join
			</button>
		</SettingItem>
	{/if}
{/if}
