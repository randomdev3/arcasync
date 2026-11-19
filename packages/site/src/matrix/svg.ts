/**
 * Dot-matrix SVG from rows of `#`/`R`/`.` and from the scene's still frame. Each dot is a
 * zero-length stroke with round caps, so a whole glyph is one short path. Colours come from the
 * `.dots` classes (page) or from presentation attributes (standalone files): the CSP allows no
 * inline styles.
 */
import { paint, RED, stillScene } from "./scene";

/** Radius of a dot as a share of the pitch: unlit, and fully lit. */
export const R_OFF = 0.17;
export const R_ON = 0.37;

/** Units per dot in generated SVG. */
const U = 10;

const dot = (x: number, y: number) => `M${x * U + U / 2} ${y * U + U / 2}h0`;

export interface DotsOptions {
	className?: string;
	/** Draws the unlit dots too, as a lattice behind the lit ones. */
	lattice?: boolean;
	/** Standalone file: colours as attributes instead of classes. */
	colors?: { on: string; red: string; off?: string };
	title?: string;
}

export function dotsSvg(rows: string[], options: DotsOptions = {}): string {
	const width = (rows[0] ?? "").length;
	const paths = { "#": "", R: "", ".": "" };
	rows.forEach((row, y) => {
		[...row].forEach((ch, x) => {
			if (ch === "#" || ch === "R" || ch === ".") paths[ch] += dot(x, y);
		});
	});
	const { colors } = options;
	const attr = (kind: "on" | "red" | "off") =>
		colors
			? `fill="none" stroke-linecap="round" stroke-width="${kind === "off" ? R_OFF * 2 * U : R_ON * 2 * U}" stroke="${colors[kind] ?? colors.on}"`
			: `class="dots__${kind}"`;
	const body = [
		options.lattice && paths["."] ? `<path ${attr("off")} d="${paths["."]}"/>` : "",
		paths["#"] ? `<path ${attr("on")} d="${paths["#"]}"/>` : "",
		paths.R ? `<path ${attr("red")} d="${paths.R}"/>` : "",
	].join("");
	const head = colors
		? `xmlns="http://www.w3.org/2000/svg"`
		: `class="dots${options.className ? ` ${options.className}` : ""}" aria-hidden="true" focusable="false"`;
	const title = options.title ? `<title>${options.title}</title>` : "";
	return `<svg ${head} viewBox="0 0 ${width * U} ${rows.length * U}">${title}${body}</svg>`;
}

/** The scene's still frame as an SVG that fills its box from the left, cropping the far side. */
export function sceneSvg(cols: number, rows: number, narrow: boolean, className: string): string {
	const scene = stillScene(cols, rows, { narrow });
	const level = new Float32Array(cols * rows);
	const tone = new Uint8Array(cols * rows);
	paint(scene, level, tone);
	const groups = new Map<string, string>();
	for (let i = 0; i < level.length; i++) {
		const value = level[i] ?? 0;
		if (value <= 0) continue;
		const key = `${tone[i] === RED ? "red" : "on"}:${Math.round(value * 100) / 100}`;
		groups.set(key, (groups.get(key) ?? "") + dot(i % cols, Math.floor(i / cols)));
	}
	const id = `lattice-${className}`;
	const lit = [...groups].map(([key, d]) => {
		const [kind, value] = key.split(":");
		const v = Number(value);
		const width = (R_OFF + (R_ON - R_OFF) * v) * 2 * U;
		return `<path class="still__${kind}" stroke-width="${width.toFixed(2)}" stroke-opacity="${v}" d="${d}"/>`;
	});
	return [
		`<svg class="display__still display__still--${className}" viewBox="0 0 ${cols * U} ${rows * U}" preserveAspectRatio="xMinYMid slice" aria-hidden="true" focusable="false">`,
		`<defs><pattern id="${id}" width="${U}" height="${U}" patternUnits="userSpaceOnUse"><circle class="still__lattice" cx="${U / 2}" cy="${U / 2}" r="${R_OFF * U}"/></pattern></defs>`,
		`<rect width="100%" height="100%" fill="url(#${id})"/>`,
		...lit,
		"</svg>",
	].join("");
}
