<script lang="ts">
import type { Readable } from "svelte/store";
import type { AvatarModel } from "../../presence/avatars";
import Avatar from "./Avatar.svelte";

const {
	vm,
}: {
	vm: Readable<{
		avatars: AvatarModel[];
		/** User id this client follows, or null. */
		following: string | null;
		onselect: (userId: string, follow: boolean) => void;
		onmenu: (userId: string, event: MouseEvent) => void;
	}>;
} = $props();
</script>

<div class="teamsync-facepile" class:is-empty={$vm.avatars.length === 0}>
	{#each $vm.avatars as avatar (avatar.userId)}
		<Avatar
			{avatar}
			following={$vm.following === avatar.userId}
			onselect={(follow) => $vm.onselect(avatar.userId, follow)}
			onmenu={(event) => $vm.onmenu(avatar.userId, event)}
		/>
	{/each}
</div>

<style>
	.teamsync-facepile {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		padding: 0 var(--size-4-1);
	}

	.teamsync-facepile.is-empty {
		display: none;
	}
</style>
