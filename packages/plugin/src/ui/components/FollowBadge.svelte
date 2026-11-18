<script lang="ts">
import type { Readable } from "svelte/store";

/** `user` is the followed user, or null to hide the badge. */
const {
	vm,
}: { vm: Readable<{ user: { name: string; color: string } | null; onStop: () => void }> } =
	$props();
</script>

{#if $vm.user}
	<div
		class="teamsync-follow-badge"
		role="status"
		style:--teamsync-follow-color={$vm.user.color}
	>
		<span class="teamsync-follow-dot"></span>
		<span class="teamsync-follow-text">Following {$vm.user.name}</span>
		<button
			class="teamsync-follow-stop"
			type="button"
			aria-label="Stop following"
			title="Stop following"
			onclick={() => $vm.onStop()}>Stop</button
		>
	</div>
{/if}

<style>
	.teamsync-follow-badge {
		position: fixed;
		top: calc(var(--header-height, 40px) + var(--size-4-2));
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--layer-notice);
		display: flex;
		align-items: center;
		gap: var(--size-4-2);
		padding: var(--size-4-1) var(--size-4-1) var(--size-4-1) var(--size-4-3);
		border: 2px solid var(--teamsync-follow-color);
		border-radius: var(--radius-l);
		background-color: var(--background-primary);
		box-shadow: var(--shadow-s);
		font-size: var(--font-ui-small);
		color: var(--text-normal);
	}

	.teamsync-follow-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background-color: var(--teamsync-follow-color);
	}

	.teamsync-follow-stop {
		font-size: var(--font-ui-smaller);
		padding: 0 var(--size-4-2);
		height: auto;
	}
</style>
