import { readFileSync } from "node:fs";
import * as decoding from "lib0/decoding";
import { describe, expect, it } from "vitest";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import {
	awarenessRemoval,
	decodeAwareness,
	encode,
	encodeAwareness,
	isEmptyUpdate,
	MessageType,
	parseFrame,
	SyncStep,
} from "../src/protocol";

/** Frames recorded by `scripts/trace-frames.ts` between @hocuspocus/provider 4.7 and the Node server. */
const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/node-frames.json", import.meta.url), "utf8"),
) as Array<{ client: string; dir: "in" | "out"; hex: string }>;
const frames = fixture.map((f) => ({ ...f, bytes: new Uint8Array(Buffer.from(f.hex, "hex")) }));

/** Re-encodes a server→client frame from its decoded fields with our encoders. */
function reencodeServerFrame(bytes: Uint8Array): Uint8Array {
	const d = decoding.createDecoder(bytes);
	const address = decoding.readVarString(d);
	const type = decoding.readVarUint(d);
	switch (type) {
		case MessageType.Auth: {
			expect(decoding.readVarUint(d)).toBe(2);
			return encode.authenticated(address, decoding.readVarString(d) === "readonly");
		}
		case MessageType.Sync: {
			const step = decoding.readVarUint(d);
			const payload = decoding.readVarUint8Array(d);
			if (step === SyncStep.Step1) return encode.syncStep1(address, payload);
			if (step === SyncStep.Step2) return encode.syncStep2(address, payload);
			return encode.update(address, payload);
		}
		case MessageType.Awareness:
			return encode.awareness(address, decoding.readVarUint8Array(d));
		case MessageType.SyncStatus:
			return encode.syncStatus(address, decoding.readVarUint(d) === 1);
		default:
			throw new Error(`unexpected server frame type ${type}`);
	}
}

describe("protocol (against recorded provider ↔ Node server frames)", () => {
	it("has a meaningful fixture", () => {
		expect(frames.filter((f) => f.dir === "in").length).toBeGreaterThan(10);
		expect(frames.filter((f) => f.dir === "out").length).toBeGreaterThan(10);
	});

	it("reproduces every server frame byte-for-byte", () => {
		for (const f of frames.filter((x) => x.dir === "in")) {
			expect(Buffer.from(reencodeServerFrame(f.bytes)).toString("hex")).toBe(f.hex);
		}
	});

	it("parses every client frame and re-encodes sync/awareness payloads exactly", () => {
		const kinds = new Set<string>();
		for (const f of frames.filter((x) => x.dir === "out")) {
			const frame = parseFrame(f.bytes);
			kinds.add(frame.kind);
			if (frame.kind === "sync") {
				const again =
					frame.step === SyncStep.Step1
						? encode.syncStep1(frame.address, frame.payload)
						: frame.step === SyncStep.Step2
							? encode.syncStep2(frame.address, frame.payload)
							: encode.update(frame.address, frame.payload);
				expect(Buffer.from(again).toString("hex")).toBe(f.hex);
			}
			if (frame.kind === "awareness") {
				expect(Buffer.from(encode.awareness(frame.address, frame.update)).toString("hex")).toBe(
					f.hex,
				);
				expect(encodeAwareness(decodeAwareness(frame.update))).toEqual(frame.update);
			}
			if (frame.kind === "auth") {
				expect(frame.token.split(".")).toHaveLength(3);
				expect(frame.providerVersion).toMatch(/^4\./);
			}
		}
		expect([...kinds].sort()).toEqual(["auth", "awareness", "close", "sync"]);
	});

	it("matches the server reply order for a client SyncStep1: Sync(0) step1, then Sync(0) step2", () => {
		const b = frames.filter((f) => f.client === "b" && f.dir === "in");
		const syncTypes = b
			.map((f) => parseFrame(f.bytes))
			.filter((p) => p.kind === "sync")
			.map((p) => (p.kind === "sync" ? p.step : -1));
		expect(syncTypes.slice(0, 2)).toEqual([SyncStep.Step1, SyncStep.Step2]);
	});

	it("builds awareness removals that y-protocols accepts at the owner's clock", () => {
		const doc = new Y.Doc();
		const owner = new Awareness(doc);
		owner.setLocalState({ user: "a" });
		const observer = new Awareness(new Y.Doc());
		applyAwarenessUpdate(observer, encodeAwarenessUpdate(owner, [doc.clientID]), "test");
		expect(observer.getStates().has(doc.clientID)).toBe(true);
		const [entry] = decodeAwareness(encodeAwarenessUpdate(owner, [doc.clientID]));
		if (!entry) throw new Error("no entry");
		applyAwarenessUpdate(observer, awarenessRemoval({ [entry.clientId]: entry.clock }), "test");
		expect(observer.getStates().has(doc.clientID)).toBe(false);
	});

	it("handles connection-level ping/pong and empty updates", () => {
		expect(parseFrame(new Uint8Array([MessageType.Ping]))).toEqual({ kind: "ping" });
		expect(parseFrame(new Uint8Array([MessageType.Pong]))).toEqual({ kind: "pong" });
		expect(isEmptyUpdate(new Uint8Array([0, 0]))).toBe(true);
		expect(isEmptyUpdate(Y.encodeStateAsUpdate(new Y.Doc()))).toBe(true);
	});
});
