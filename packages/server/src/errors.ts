import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiException extends HTTPException {
	readonly code: string;
	readonly details: unknown;

	constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
		super(status, { message });
		this.code = code;
		this.details = details;
	}
}

export const badRequest = (message: string, details?: unknown) =>
	new ApiException(400, "bad_request", message, details);
export const unauthorized = (message = "Unauthorized") =>
	new ApiException(401, "unauthorized", message);
export const forbidden = (message = "Forbidden") => new ApiException(403, "forbidden", message);
export const notFound = (message = "Not found") => new ApiException(404, "not_found", message);
export const conflict = (message: string) => new ApiException(409, "conflict", message);
