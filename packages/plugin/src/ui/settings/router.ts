/**
 * The settings tab is a stack of pages: a root (welcome when signed out, home when signed in) and
 * the pages opened from it. Pure, so the tab and the tests share it.
 */
export type Page =
	| { kind: "welcome" }
	| { kind: "password" }
	| { kind: "join" }
	| { kind: "home" }
	| { kind: "team"; teamId: string };

export interface PageStack {
	/** Pages under `current`, oldest first; empty on a root page. */
	history: Page[];
	current: Page;
}

/** What decides whether a page can still be shown. */
export interface RouteContext {
	signedIn: boolean;
	/** Ids of the teams the account belongs to; null while unknown (a team page then stays). */
	teamIds: ReadonlySet<string> | null;
}

const SIGNED_OUT = new Set<Page["kind"]>(["welcome", "password", "join"]);

export function rootPage(signedIn: boolean): Page {
	return signedIn ? { kind: "home" } : { kind: "welcome" };
}

export function isRoot(page: Page): boolean {
	return page.kind === "welcome" || page.kind === "home";
}

export function samePage(a: Page, b: Page): boolean {
	if (a.kind !== b.kind) return false;
	return a.kind !== "team" || a.teamId === (b as { teamId: string }).teamId;
}

export function initialStack(signedIn: boolean): PageStack {
	return { history: [], current: rootPage(signedIn) };
}

/** Opens `page` on top of the stack; a root page clears it, the current page is a no-op. */
export function push(stack: PageStack, page: Page): PageStack {
	if (samePage(stack.current, page)) return stack;
	if (isRoot(page)) return { history: [], current: page };
	return { history: [...stack.history, stack.current], current: page };
}

/** Goes back one page (to the root at worst). */
export function back(stack: PageStack, signedIn: boolean): PageStack {
	const history = [...stack.history];
	const previous = history.pop();
	return { history, current: previous ?? rootPage(signedIn) };
}

/** A page shown from outside the tab (a file menu): the root, then `page`. */
export function openAt(page: Page, signedIn: boolean): PageStack {
	return push(initialStack(signedIn), page);
}

function valid(page: Page, context: RouteContext): boolean {
	if (SIGNED_OUT.has(page.kind) !== !context.signedIn) return false;
	if (page.kind === "team") return context.teamIds === null || context.teamIds.has(page.teamId);
	return true;
}

/**
 * Drops pages that can no longer be shown: signed-out pages once signed in (and the reverse),
 * and the page of a team the account left. Returns `stack` itself when nothing changed.
 */
export function resolve(stack: PageStack, context: RouteContext): PageStack {
	const pages = [...stack.history, stack.current];
	const kept = pages.filter((page) => valid(page, context));
	if (kept.length === pages.length) return stack;
	const root = rootPage(context.signedIn);
	const rest = kept.filter((page) => !isRoot(page));
	const current = rest.pop() ?? root;
	return { history: isRoot(current) ? [] : [root, ...rest], current };
}
