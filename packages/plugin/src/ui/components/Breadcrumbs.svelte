<script lang="ts">
import { icon } from "./icon";

/** "ArcaSync › Team": the first items go back, the last names the page. */
const {
	items,
	onback,
}: { items: { label: string; onclick?: () => void }[]; onback?: () => void } = $props();
</script>

<nav class="arcasync-breadcrumbs">
	{#if onback}
		<button
			class="clickable-icon arcasync-back"
			aria-label="Back"
			use:icon={"chevron-left"}
			onclick={() => onback?.()}
		></button>
	{/if}
	{#each items as item, index (index)}
		{#if index > 0}
			<span class="arcasync-breadcrumb-separator" use:icon={"chevron-right"}></span>
		{/if}
		{#if item.onclick && index < items.length - 1}
			<button class="arcasync-breadcrumb is-link" onclick={() => item.onclick?.()}>{item.label}</button>
		{:else}
			<span class="arcasync-breadcrumb is-current">{item.label}</span>
		{/if}
	{/each}
</nav>
