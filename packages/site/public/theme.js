// Classic blocking script in <head>: applies a stored "light"/"dark" choice before first paint, so
// there is no flash under a CSP without inline scripts. "system" (or nothing) leaves the attribute
// off and the CSS follows prefers-color-scheme.
try {
	const theme = localStorage.getItem("arcasync.theme");
	if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}
