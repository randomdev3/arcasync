<script lang="ts">
import type { Snippet } from "svelte";

/** One Obsidian setting row: name and description on the left, controls on the right. */
const {
	name = "",
	description = "",
	heading = false,
	cls = "",
	onclick,
	lead,
	nameSnippet,
	descriptionSnippet,
	children,
}: {
	name?: string;
	description?: string;
	heading?: boolean;
	cls?: string;
	/** Makes the whole row open something (a page). */
	onclick?: () => void;
	/** Rendered before the name (an avatar, an icon). */
	lead?: Snippet;
	nameSnippet?: Snippet;
	descriptionSnippet?: Snippet;
	children?: Snippet;
} = $props();

function rowClick(event: MouseEvent) {
	if (!onclick) return;
	// Controls in the row handle their own clicks.
	if ((event.target as HTMLElement).closest("button, input, select, a, .clickable-icon")) return;
	onclick();
}

function rowKey(event: KeyboardEvent) {
	if (!onclick || event.target !== event.currentTarget) return;
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	onclick();
}
</script>

{#if onclick}
	<div
		class="setting-item arcasync-nav-row {cls}"
		class:setting-item-heading={heading}
		role="button"
		tabindex="0"
		onclick={rowClick}
		onkeydown={rowKey}
	>
		{@render body()}
	</div>
{:else}
	<div class="setting-item {cls}" class:setting-item-heading={heading}>
		{@render body()}
	</div>
{/if}

{#snippet body()}
	{#if lead}
		<div class="arcasync-item-icon">{@render lead()}</div>
	{/if}
	<div class="setting-item-info">
		<div class="setting-item-name">
			{#if nameSnippet}{@render nameSnippet()}{:else}{name}{/if}
		</div>
		{#if descriptionSnippet || description}
			<div class="setting-item-description">
				{#if descriptionSnippet}{@render descriptionSnippet()}{:else}{description}{/if}
			</div>
		{/if}
	</div>
	<div class="setting-item-control">
		{#if children}{@render children()}{/if}
	</div>
{/snippet}
