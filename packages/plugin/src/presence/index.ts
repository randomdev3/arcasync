import { Platform } from "obsidian";
import { toWs } from "../workspace/paths";
import type { WorkspaceSession } from "../workspace/WorkspaceSession";
import { FacepileMount } from "./FacepileMount";
import { PresenceService, presenceUser } from "./PresenceService";

const INPUT_EVENTS = ["keydown", "mousemove", "pointerdown"] as const;

/**
 * Starts workspace presence for a started session: `session.presence` publishes the focused note
 * and idle state on the index-doc awareness, drives the presence policies' idle renewal, and
 * feeds the view-header facepiles. Returns the function that stops it (before the session's
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
	const facepile = new FacepileMount(app, presence, session.user.id, root);
	facepile.start();

	return () => {
		facepile.stop();
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
