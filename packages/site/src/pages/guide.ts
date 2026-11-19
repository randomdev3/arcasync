import "../styles/main.css";
import "../styles/guide.css";
import { initChrome } from "../lib/chrome";

initChrome();

// The table of contents is a collapsed <details> on small screens and an always-open rail on wide
// ones (where its summary is not clickable).
const details = document.querySelector<HTMLDetailsElement>(".toc__details");
const wide = window.matchMedia("(min-width: 960px)");
const syncToc = () => {
	if (details) details.open = wide.matches;
};
syncToc();
wide.addEventListener("change", syncToc);

// Marks the section being read in the table of contents.
const links = new Map<string, HTMLAnchorElement>();
for (const link of document.querySelectorAll<HTMLAnchorElement>(".toc__list a")) {
	links.set(link.hash.slice(1), link);
}
if ("IntersectionObserver" in window) {
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				for (const link of links.values()) link.removeAttribute("aria-current");
				links.get(entry.target.id)?.setAttribute("aria-current", "true");
			}
		},
		{ rootMargin: "-20% 0px -70% 0px" },
	);
	for (const id of links.keys()) {
		const section = document.getElementById(id);
		if (section) observer.observe(section);
	}
}
