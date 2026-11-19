import type { Role, User, WorkspaceSummary } from "@arcasync/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import type { UserRow } from "../db/schema.js";
import { memberships, workspaces } from "../db/schema.js";

export function toApiUser(row: UserRow): User {
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		color: row.color,
		avatarUrl: row.avatarUrl,
		isAdmin: row.isAdmin,
	};
}

export async function workspacesForUser(db: Db, userId: string): Promise<WorkspaceSummary[]> {
	const rows = await db
		.select({
			id: workspaces.id,
			slug: workspaces.slug,
			name: workspaces.name,
			role: memberships.role,
		})
		.from(memberships)
		.innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
		.where(and(eq(memberships.userId, userId), isNull(workspaces.deletedAt)));
	return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, role: r.role as Role }));
}
