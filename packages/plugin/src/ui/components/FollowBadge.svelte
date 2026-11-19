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
		class="arcasync-follow-badge"
		role="status"
		style:--arcasync-follow-color={$vm.user.color}
	>
		<span class="arcasync-follow-dot"></span>
		<span class="arcasync-follow-text">Following {$vm.user.name}</span>
		<button
			class="arcasync-follow-stop"
			type="button"
			aria-label="Stop following"
			title="Stop following"
			onclick={() => $vm.onStop()}>Stop</button
		>
	</div>
{/if}

<style>
	.arcasync-follow-badge {
		position: fixed;
		/* Bottom centre: clear of view headers, notices (top right) and the status bar (right). */
		bottom: calc(var(--size-4-12, 48px) + env(safe-area-inset-bottom, 0px));
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--layer-notice);
		display: flex;
		align-items: center;
		gap: var(--size-4-2);
		padding: var(--size-4-1) var(--size-4-1) var(--size-4-1) var(--size-4-3);
		border: 2px solid var(--arcasync-follow-color);
		border-radius: var(--radius-l);
		background-color: var(--background-primary);
		box-shadow: var(--shadow-s);
		font-size: var(--font-ui-small);
		color: var(--text-normal);
	}

	.arcasync-follow-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background-color: var(--arcasync-follow-color);
	}

	.arcasync-follow-stop {
		font-size: var(--font-ui-smaller);
		padding: 0 var(--size-4-2);
		height: auto;
	}
</style>
