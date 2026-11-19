import type { Role } from "@arcasync/shared";
import { parseDocName } from "@arcasync/shared";
import type { onAuthenticatePayload, onTokenSyncPayload } from "@hocuspocus/server";
import { verifyWsToken } from "../auth/tokens.js";
import type { Deps } from "../types.js";

export interface CollabContext {
	userId: string;
	workspaceId: string;
	role: Role;
	deviceId: string;
}

/**
 * Verifies the HS256 WebSocket JWT and binds it to the requested document.
 * A token minted for workspace A can never open a document of workspace B.
 */
export async function authenticateDoc(
	deps: Deps,
	token: string,
	documentName: string,
): Promise<{ context: CollabContext; readOnly: boolean }> {
	const ref = parseDocName(documentName);
	if (!ref) throw new Error(`Unknown document name: ${documentName}`);

	let claims: Awaited<ReturnType<typeof verifyWsToken>>;
	try {
		claims = await verifyWsToken(token, deps.config.secret);
	} catch (err) {
		deps.log.debug({ err, documentName }, "ws token rejected");
		throw new Error("Invalid or expired token");
	}

	if (claims.ws !== ref.workspaceId) {
		throw new Error("Token is not valid for this workspace");
	}

	return {
		context: {
			userId: claims.sub,
			workspaceId: claims.ws,
			role: claims.role,
			deviceId: claims.dev,
		},
		readOnly: claims.role === "viewer",
	};
}

export function createOnAuthenticate(deps: Deps) {
	return async (data: onAuthenticatePayload): Promise<CollabContext> => {
		const { context, readOnly } = await authenticateDoc(deps, data.token, data.documentName);
		// There is no `connection` yet at authenticate time; `connectionConfig` is the
		// object the `Connection` is later built from.
		data.connectionConfig.readOnly = readOnly;
		deps.log.debug(
			{ documentName: data.documentName, userId: context.userId, readOnly },
			"ws authenticated",
		);
		return context;
	};
}

export function createOnTokenSync(deps: Deps) {
	return async (data: onTokenSyncPayload): Promise<CollabContext> => {
		const { context, readOnly } = await authenticateDoc(deps, data.token, data.documentName);
		data.connectionConfig.readOnly = readOnly;
		data.connection.readOnly = readOnly;
		return context;
	};
}
