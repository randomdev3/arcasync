import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { memberships, workspaces } from "./db/schema.js";

export const DEV_WORKSPACE_SLUG = "dev";

/** Creates the `dev` workspace on first boot so dev-login has somewhere to put people. */
export async function ensureDevWorkspace(db: Db): Promise<string> {
	const [existing] = await db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(eq(workspaces.slug, DEV_WORKSPACE_SLUG))
		.limit(1);
	if (existing) return existing.id;

	const [created] = await db
		.insert(workspaces)
		.values({ slug: DEV_WORKSPACE_SLUG, name: "Dev" })
		.onConflictDoNothing({ target: workspaces.slug })
		.returning({ id: workspaces.id });
	if (created) return created.id;

	const [raced] = await db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(eq(workspaces.slug, DEV_WORKSPACE_SLUG))
		.limit(1);
	if (!raced) throw new Error("failed to create dev workspace");
	return raced.id;
}

export async function ensureMembership(
	db: Db,
	workspaceId: string,
	userId: string,
	role: string,
): Promise<void> {
	await db
		.insert(memberships)
		.values({ workspaceId, userId, role })
		.onConflictDoNothing({ target: [memberships.workspaceId, memberships.userId] });
}
