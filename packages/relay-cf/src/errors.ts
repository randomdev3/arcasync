/** The API error body shared by every route: `{error: {code, message, details?}}`. */
export const errorBody = (code: string, message: string, details?: unknown) => ({
	error: { code, message, ...(details === undefined ? {} : { details }) },
});
