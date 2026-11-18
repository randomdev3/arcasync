import { Platform } from "obsidian";
import FollowBadge from "../ui/components/FollowBadge.svelte";
import { mountComponent } from "../ui/svelteHost";
import { toWs } from "../workspace/paths";
import type { WorkspaceSession } from "../workspace/WorkspaceSession";
import { FacepileMount } from "./FacepileMount";
import { Navigator } from "./Navigator";
import { ObsidianNavigatorPort } from "./navigatorPort";
import { PresenceService, presenceUser } from "./PresenceService";

type FollowBadgeProps = { user: { name: string; color: string } | null; onStop: () => void };

/** The navigator of a session with a mapped folder, and its "Following …" badge. */
function startNavigator(session: WorkspaceSession, presence: PresenceService, root: string) {
	const navigator = new Navigator({
		presence,
		selfId: session.user.id,
		port: new ObsidianNavigatorPort(session, root),
		publishFollowing: (userId) => presence.setFollowing(userId),
	});
	const badge = mountComponent<FollowBadgeProps>(FollowBadge, {
		target: window.document.body,
		props: { user: null, onStop: () => navigator.unfollow() },
	});
	const offChange = navigator.onChange(() => badge.set({ user: navigator.followedUser }));
	session.navigator = navigator;
	return {
		navigator,
		stop: () => {
			offChange();
			navigator.dispose();
			badge.destroy();
			if (session.navigator === navigator) session.navigator = null;
		},
	};
}

const INPUT_EVENTS = ["keydown", "mousemove", "pointerdown"] as const;

/**
 * Starts workspace presence for a started session: `session.presence` publishes the focused note
 * and idle state on the index-doc awareness, drives the presence policies' idle renewal, and
 * feeds the view-header facepiles. With a mapped folder, `session.navigator` jumps to and follows
 * other users from their avatars and the commands. Returns the function that stops it (before the session's
 * awareness is destroyed).
 */
export function startPresence(session: WorkspaceSession): () => void {
	const { app, connections, root } = session;
	const doc = window.document;
	const presence = new PresenceService({
		awareness: session.awareness,
		user: presenceUser(session.user),
		device: { id: session.vaultId, platform: Platform.isMobile ? "mobile" : "desktop" },
		hidden: doc.visibilityState === "hidden",
		onIdleChange: () => connections.refreshPresence(),
	});

	const syncFile = () => {
		const path = app.workspace.getActiveFile()?.path;
		presence.setFile(path && root !== null ? toWs(root, path) : null);
	};
	const refs = [
		app.workspace.on("active-leaf-change", syncFile),
		app.workspace.on("file-open", syncFile),
	];
	const renameRef = app.vault.on("rename", syncFile);
	syncFile();

	const onInput = () => presence.input();
	const onVisibility = () => presence.setHidden(doc.visibilityState === "hidden");
	for (const type of INPUT_EVENTS) {
		doc.addEventListener(type, onInput, { capture: true, passive: true });
	}
	doc.addEventListener("visibilitychange", onVisibility);

	session.presence = presence;
	// The index doc's policy was installed before `session.presence` existed.
	connections.refreshPresence();
	const navigation = root === null ? null : startNavigator(session, presence, root);
	const facepile = new FacepileMount(
		app,
		presence,
		session.user.id,
		root,
		navigation?.navigator ?? null,
	);
	facepile.start();

	return () => {
		facepile.stop();
		navigation?.stop();
		for (const ref of refs) app.workspace.offref(ref);
		app.vault.offref(renameRef);
		for (const type of INPUT_EVENTS) {
			doc.removeEventListener(type, onInput, { capture: true });
		}
		doc.removeEventListener("visibilitychange", onVisibility);
		presence.dispose();
		if (session.presence === presence) session.presence = null;
	};
}
