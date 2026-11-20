<script lang="ts">
import { initials } from "../../presence/avatars";

const {
	name,
	color,
	avatarUrl = null,
	size = 28,
}: { name: string; color: string; avatarUrl?: string | null; size?: number } = $props();

let broken = $state(false);
const image = $derived(avatarUrl && /^https:\/\//.test(avatarUrl) && !broken ? avatarUrl : null);
</script>

<span
	class="arcasync-user-avatar"
	style:--arcasync-avatar-size="{size}px"
	style:--arcasync-avatar-color={color}
	aria-hidden="true"
>
	{#if image}
		<img src={image} alt="" referrerpolicy="no-referrer" onerror={() => (broken = true)} />
	{:else}
		{initials(name)}
	{/if}
</span>
