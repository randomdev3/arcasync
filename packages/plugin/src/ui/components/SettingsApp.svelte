<script lang="ts">
import type { Readable } from "svelte/store";
import Callout from "./Callout.svelte";
import HomePage from "./HomePage.svelte";
import SelfHosting from "./SelfHosting.svelte";
import SignedOutPage from "./SignedOutPage.svelte";
import type { SettingsViewProps } from "./settingsProps";
import TeamPage from "./TeamPage.svelte";

const { vm }: { vm: Readable<SettingsViewProps> } = $props();

const page = $derived($vm.page);
const team = $derived(page.kind === "team" ? $vm.teams.find((t) => t.id === page.teamId) : undefined);
const root = $derived(page.kind === "welcome" || page.kind === "home");
</script>

<div class="arcasync-settings" data-page={page.kind}>
	{#if $vm.serverError && root}
		<Callout title="Can't reach the server" icon="cloud-off">
			{$vm.serverError}
			<button class="arcasync-retry" onclick={() => $vm.ctl.refreshServer()}>Retry</button>
		</Callout>
	{/if}

	{#if page.kind === "home"}
		<HomePage v={$vm} />
	{:else if page.kind === "team" && team}
		<TeamPage v={$vm} {team} />
	{:else if page.kind !== "team"}
		<SignedOutPage v={$vm} />
	{/if}

	{#if root}
		<SelfHosting v={$vm} />
	{/if}
</div>
