/**
 * The loom's motion, without three.js: four carets type left to right across a ruled page
 * (page units, centred, x right, y up), each leaving a trail of recent positions. Every 8 to 12 s
 * one caret glides over to sit under another and travels with it for a few seconds (the "follow"
 * feature). Fixed 50 Hz steps, seeded, so a still frame is reproducible.
 */

export const PAGE = { width: 4.2, height: 2.8 } as const;
/** Heads type across the page, fading in at its left edge and out at its right, then start over. */
export const X_START = -2.15;
export const X_END = 2.05;
export const STEP_S = 1 / 50;
/** Trail samples per caret, one every other step (about 6.4 s of movement). */
export const TRAIL = 160;
const SAMPLE_EVERY = 2;

export const NAMES = ["mara", "jun", "teo", "ines"] as const;
const BASELINES = [0.86, 0.3, -0.26, -0.82];
const SPEEDS = [0.36, 0.42, 0.31, 0.39];
const FOLLOW_GAP_X = 0.4;
/** Far enough below the leader that the two name flags never overlap. */
const FOLLOW_GAP_Y = 0.42;

export interface Head {
	name: string;
	baseline: number;
	speed: number;
	phase: number;
	x: number;
	y: number;
	/** `TRAIL` (x, y) pairs, oldest first once `filled`; a ring starting at `cursor`. */
	trail: Float32Array;
	cursor: number;
}

export interface Follow {
	follower: number;
	leader: number;
	until: number;
}

export interface Sim {
	t: number;
	heads: Head[];
	follow: Follow | null;
	nextFollowAt: number;
	rand: () => number;
	carry: number;
	steps: number;
}

/** mulberry32: small, seeded, good enough for motion. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function resetTrail(head: Head): void {
	for (let i = 0; i < TRAIL; i++) {
		head.trail[i * 2] = head.x;
		head.trail[i * 2 + 1] = head.y;
	}
	head.cursor = 0;
}

export function createSim(seed = 7): Sim {
	const rand = rng(seed);
	const heads = NAMES.map((name, i) => {
		const head: Head = {
			name,
			baseline: BASELINES[i] ?? 0,
			speed: SPEEDS[i] ?? 0.35,
			phase: rand() * Math.PI * 2,
			// Staggered so the carets are spread over the page from the first frame.
			x: -1.6 + i * 0.85 - rand() * 0.3,
			y: BASELINES[i] ?? 0,
			trail: new Float32Array(TRAIL * 2),
			cursor: 0,
		};
		resetTrail(head);
		return head;
	});
	return { t: 0, heads, follow: null, nextFollowAt: 4 + rand() * 3, rand, carry: 0, steps: 0 };
}

/** Typing rhythm: bursts and short pauses, never quite stopped. */
function rhythm(t: number, phase: number): number {
	const burst = 0.55 + 0.45 * Math.sin(t * 3.1 + phase) * Math.sin(t * 0.7 + phase * 2);
	return Math.max(0.08, burst);
}

const onPage = (x: number) => x > -1.6 && x < 1.1;

export function startFollow(sim: Sim, follower: number, leader: number, seconds: number): void {
	sim.follow = { follower, leader, until: sim.t + seconds };
}

function maybeFollow(sim: Sim): void {
	if (sim.follow && (sim.t >= sim.follow.until || !onPage(sim.heads[sim.follow.leader]?.x ?? 99))) {
		sim.follow = null;
		sim.nextFollowAt = sim.t + 8 + sim.rand() * 4;
	}
	if (sim.follow || sim.t < sim.nextFollowAt) return;
	const candidates = sim.heads.map((h, i) => (onPage(h.x) ? i : -1)).filter((i) => i >= 0);
	if (candidates.length < 2) {
		sim.nextFollowAt = sim.t + 1;
		return;
	}
	const pick = () => candidates[Math.floor(sim.rand() * candidates.length)] ?? 0;
	const leader = pick();
	let follower = pick();
	while (follower === leader) follower = pick();
	startFollow(sim, follower, leader, 3.5 + sim.rand() * 1.5);
}

function stepOnce(sim: Sim): void {
	sim.t += STEP_S;
	sim.steps += 1;
	const sample = sim.steps % SAMPLE_EVERY === 0;
	maybeFollow(sim);
	sim.heads.forEach((head, i) => {
		const following = sim.follow?.follower === i ? sim.heads[sim.follow.leader] : undefined;
		let targetY = head.baseline;
		let dx = head.speed * rhythm(sim.t, head.phase) * STEP_S;
		if (following) {
			targetY = following.y - FOLLOW_GAP_Y;
			// Glide to just behind the leader, then keep its pace. Never backwards: a caret ahead of
			// its spot just slows down, so the trail bends instead of folding back.
			const gap = following.x - FOLLOW_GAP_X - head.x;
			dx = Math.max(0.06 * STEP_S, Math.min(1.2 * STEP_S, (gap * 1.6 + 0.25) * STEP_S));
		}
		head.x += dx;
		head.y += (targetY - head.y) * Math.min(1, 1.5 * STEP_S);
		const limit = PAGE.height / 2 - 0.12;
		head.y = Math.max(-limit, Math.min(limit, head.y));
		if (head.x > X_END) {
			head.x = X_START;
			head.y = head.baseline;
			if (sim.follow && (sim.follow.follower === i || sim.follow.leader === i))
				sim.follow.until = sim.t;
			resetTrail(head);
			return;
		}
		if (!sample) return;
		head.trail[head.cursor * 2] = head.x;
		head.trail[head.cursor * 2 + 1] = head.y;
		head.cursor = (head.cursor + 1) % TRAIL;
	});
}

/** Advances by `dt` seconds in fixed steps (a long pause is capped, not replayed). */
export function step(sim: Sim, dt: number): void {
	sim.carry += Math.min(dt, 0.25);
	while (sim.carry >= STEP_S) {
		sim.carry -= STEP_S;
		stepOnce(sim);
	}
}

/** Runs `seconds` of motion at once (warm-up, so trails exist on the first frame). */
export function advance(sim: Sim, seconds: number): void {
	for (let i = 0; i < seconds / STEP_S; i++) stepOnce(sim);
}

/** The trail sample `j` (0 = oldest, TRAIL - 1 = the head) as [x, y]. */
export function trailPoint(head: Head, j: number, out: [number, number]): [number, number] {
	const k = (head.cursor + j) % TRAIL;
	out[0] = head.trail[k * 2] ?? head.x;
	out[1] = head.trail[k * 2 + 1] ?? head.y;
	return out;
}

/** The composed still for reduced motion: carets spread out, two of them mid-follow. */
export function stillFrame(): Sim {
	const sim = createSim(11);
	sim.nextFollowAt = Number.POSITIVE_INFINITY;
	advance(sim, 6);
	startFollow(sim, 1, 0, 60);
	advance(sim, 2.4);
	return sim;
}

/** 0 at the ends of a head's run, 1 in between: carets fade in and out at the page edges. */
export function edgeFade(x: number): number {
	const ramp = (v: number) => Math.min(1, Math.max(0, v));
	const a = ramp((x - X_START) / 0.35);
	const b = ramp((X_END - x) / 0.35);
	return a * a * (3 - 2 * a) * (b * b * (3 - 2 * b));
}

/** Surface swell (page units): the same two sines as the page's vertex shader. */
export function swell(x: number, y: number, t: number): number {
	return 0.05 * Math.sin(x * 1.1 + t * 0.45) + 0.035 * Math.sin(y * 1.7 - t * 0.35 + x * 0.4);
}

/**
 * A thread's height over the page: it crosses the surface, so the page hides the stretches below
 * it (about a third: the bias keeps the thread mostly on top, so it still reads as a line).
 */
export function weave(x: number, phase: number): number {
	return 0.05 * (Math.sin(x * 5.5 + phase) + 0.45);
}
