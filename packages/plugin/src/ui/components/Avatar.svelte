<script lang="ts">
import type { AvatarModel } from "../../presence/avatars";

const {
	avatar,
	following,
	onselect,
	onmenu,
}: {
	avatar: AvatarModel;
	following: boolean;
	/** Click (`follow` with Shift) or Enter/Space. */
	onselect: (follow: boolean) => void;
	onmenu: (event: MouseEvent) => void;
} = $props();

function onkeydown(event: KeyboardEvent) {
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	onselect(event.shiftKey);
}
</script>

<span
	class="teamsync-avatar"
	class:is-followed={following}
	role="button"
	tabindex="0"
	data-user-id={avatar.userId}
	data-state={avatar.state}
	title={avatar.title}
	aria-label={avatar.title}
	style:--teamsync-avatar-color={avatar.color}
	onclick={(event) => onselect(event.shiftKey)}
	oncontextmenu={(event) => {
		event.preventDefault();
		onmenu(event);
	}}
	{onkeydown}
>{avatar.initials}</span>

<style>
	.teamsync-avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		margin-left: -6px;
		border: 2px solid var(--background-primary);
		background-color: var(--teamsync-avatar-color);
		color: #fff;
		font-size: 10px;
		font-weight: var(--font-bold);
		line-height: 1;
		cursor: pointer;
		user-select: none;
		transition: opacity 150ms ease;
	}

	.teamsync-avatar.is-followed {
		box-shadow: 0 0 0 2px var(--teamsync-avatar-color);
	}

	.teamsync-avatar:first-child {
		margin-left: 0;
	}

	.teamsync-avatar[data-state="elsewhere"] {
		opacity: 0.45;
	}

	.teamsync-avatar[data-state="idle"] {
		opacity: 0.3;
		filter: grayscale(1);
	}
</style>
