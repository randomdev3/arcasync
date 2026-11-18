<script lang="ts">
import type { AvatarModel } from "../../presence/avatars";

const { avatar }: { avatar: AvatarModel } = $props();
</script>

<span
	class="teamsync-avatar"
	data-user-id={avatar.userId}
	data-state={avatar.state}
	title={avatar.title}
	aria-label={avatar.title}
	style:--teamsync-avatar-color={avatar.color}
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
		cursor: default;
		user-select: none;
		transition: opacity 150ms ease;
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
