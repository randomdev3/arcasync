<script lang="ts">
import type { Snippet } from "svelte";
import { icon as iconAction } from "./icon";

/** A quiet hint box (Obsidian's callout look) for empty states. */
const {
	title,
	icon = "info",
	children,
}: { title: string; icon?: string; children?: Snippet } = $props();
</script>

<div class="callout arcasync-callout" data-callout="note">
	<div class="callout-title">
		<div class="callout-icon" use:iconAction={icon}></div>
		<div class="callout-title-inner">{title}</div>
	</div>
	{#if children}
		<div class="callout-content">{@render children()}</div>
	{/if}
</div>
