/**
 * Hocuspocus 4.7 wire protocol, as spoken by `@hocuspocus/provider` over one multiplexed socket.
 *
 * Every frame is `varString(address) + varUint(type) + payload`, where the address is the
 * document name (or `name\0sessionId` with provider `sessionAwareness`; replies echo it
 * verbatim). The only exceptions are the 1-byte connection-level Ping/Pong frames.
 * Enum values and payload layouts follow `@hocuspocus/server/src/{types,OutgoingMessage,
 * MessageReceiver}.ts` and `@hocuspocus/common/src/auth.ts`.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

export const MessageType = {
	Sync: 0,
	Awareness: 1,
	Auth: 2,
	QueryAwareness: 3,
	/** Server-internal in Hocuspocus; the provider has no handler for it, so never send it. */
	SyncReply: 4,
	Stateless: 5,
	BroadcastStateless: 6,
	Close: 7,
	SyncStatus: 8,
	Ping: 9,
	Pong: 10,
} as const;

export const SyncStep = { Step1: 0, Step2: 1, Update: 2 } as const;
export type SyncStep = (typeof SyncStep)[keyof typeof SyncStep];

export const AuthMessageType = { Token: 0, PermissionDenied: 1, Authenticated: 2 } as const;

export type Frame =
	| { kind: "auth"; address: string; token: string; providerVersion: string | null }
	| { kind: "sync"; address: string; step: SyncStep; payload: Uint8Array }
	| { kind: "awareness"; address: string; update: Uint8Array }
	| { kind: "queryAwareness"; address: string }
	| { kind: "stateless"; address: string; payload: string }
	| { kind: "close"; address: string }
	| { kind: "ping" }
	| { kind: "pong" }
	| { kind: "unknown"; address: string; type: number };

/** The document name part of a frame address (strips an optional `\0sessionId`). */
export function documentNameOf(address: string): string {
	const sep = address.indexOf("\0");
	return sep === -1 ? address : address.slice(0, sep);
}

/** Decodes one inbound client frame. Throws on malformed input. */
export function parseFrame(data: Uint8Array): Frame {
	if (data.length === 1 && data[0] === MessageType.Ping) return { kind: "ping" };
	if (data.length === 1 && data[0] === MessageType.Pong) return { kind: "pong" };

	const decoder = decoding.createDecoder(data);
	const address = decoding.readVarString(decoder);
	const type = decoding.readVarUint(decoder);
	switch (type) {
		case MessageType.Auth: {
			const authType = decoding.readVarUint(decoder);
			if (authType !== AuthMessageType.Token) return { kind: "unknown", address, type };
			const token = decoding.readVarString(decoder);
			const providerVersion = decoding.hasContent(decoder) ? decoding.readVarString(decoder) : null;
			return { kind: "auth", address, token, providerVersion };
		}
		case MessageType.Sync:
		case MessageType.SyncReply: {
			const step = decoding.readVarUint(decoder);
			if (step !== SyncStep.Step1 && step !== SyncStep.Step2 && step !== SyncStep.Update) {
				throw new Error(`unknown sync step ${step}`);
			}
			return { kind: "sync", address, step, payload: decoding.readVarUint8Array(decoder) };
		}
		case MessageType.Awareness:
			return { kind: "awareness", address, update: decoding.readVarUint8Array(decoder) };
		case MessageType.QueryAwareness:
			return { kind: "queryAwareness", address };
		case MessageType.Stateless:
			return { kind: "stateless", address, payload: decoding.readVarString(decoder) };
		case MessageType.Close:
			return { kind: "close", address };
		default:
			return { kind: "unknown", address, type };
	}
}

function frame(address: string, type: number, write?: (e: encoding.Encoder) => void): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarString(encoder, address);
	encoding.writeVarUint(encoder, type);
	write?.(encoder);
	return encoding.toUint8Array(encoder);
}

export const encode = {
	authenticated: (address: string, readOnly: boolean) =>
		frame(address, MessageType.Auth, (e) => {
			encoding.writeVarUint(e, AuthMessageType.Authenticated);
			encoding.writeVarString(e, readOnly ? "readonly" : "read-write");
		}),
	permissionDenied: (address: string, reason: string) =>
		frame(address, MessageType.Auth, (e) => {
			encoding.writeVarUint(e, AuthMessageType.PermissionDenied);
			encoding.writeVarString(e, reason);
		}),
	/** Server → client SyncStep1 (asks for whatever the client has that the server lacks). */
	syncStep1: (address: string, stateVector: Uint8Array) =>
		frame(address, MessageType.Sync, (e) => {
			encoding.writeVarUint(e, SyncStep.Step1);
			encoding.writeVarUint8Array(e, stateVector);
		}),
	syncStep2: (address: string, update: Uint8Array) =>
		frame(address, MessageType.Sync, (e) => {
			encoding.writeVarUint(e, SyncStep.Step2);
			encoding.writeVarUint8Array(e, update);
		}),
	update: (address: string, update: Uint8Array) =>
		frame(address, MessageType.Sync, (e) => {
			encoding.writeVarUint(e, SyncStep.Update);
			encoding.writeVarUint8Array(e, update);
		}),
	syncStatus: (address: string, saved: boolean) =>
		frame(address, MessageType.SyncStatus, (e) => encoding.writeVarUint(e, saved ? 1 : 0)),
	awareness: (address: string, update: Uint8Array) =>
		frame(address, MessageType.Awareness, (e) => encoding.writeVarUint8Array(e, update)),
	queryAwareness: (address: string) => frame(address, MessageType.QueryAwareness),
	stateless: (address: string, payload: string) =>
		frame(address, MessageType.Stateless, (e) => encoding.writeVarString(e, payload)),
	close: (address: string, reason: string) =>
		frame(address, MessageType.Close, (e) => encoding.writeVarString(e, reason)),
	ping: () => new Uint8Array([MessageType.Ping]),
};

/** One entry of a y-protocols awareness update. `state` is the raw JSON text. */
export interface AwarenessEntry {
	clientId: number;
	clock: number;
	state: string;
}

/** Decodes a y-protocols awareness update without instantiating an `Awareness`. */
export function decodeAwareness(update: Uint8Array): AwarenessEntry[] {
	const decoder = decoding.createDecoder(update);
	const count = decoding.readVarUint(decoder);
	const entries: AwarenessEntry[] = [];
	for (let i = 0; i < count; i++) {
		const clientId = decoding.readVarUint(decoder);
		const clock = decoding.readVarUint(decoder);
		const state = decoding.readVarString(decoder);
		entries.push({ clientId, clock, state });
	}
	return entries;
}

export function encodeAwareness(entries: AwarenessEntry[]): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, entries.length);
	for (const entry of entries) {
		encoding.writeVarUint(encoder, entry.clientId);
		encoding.writeVarUint(encoder, entry.clock);
		encoding.writeVarString(encoder, entry.state);
	}
	return encoding.toUint8Array(encoder);
}

/**
 * Awareness update that removes `clients` (state `null`). y-protocols accepts a removal at the
 * same clock as the live state, so the last clock seen from the owner is enough.
 */
export function awarenessRemoval(clients: Record<string, number>): Uint8Array {
	return encodeAwareness(
		Object.entries(clients).map(([id, clock]) => ({
			clientId: Number(id),
			clock,
			state: "null",
		})),
	);
}

/** `00 00`: an update with no structs and an empty delete set. */
export function isEmptyUpdate(update: Uint8Array): boolean {
	return update.length === 2 && update[0] === 0 && update[1] === 0;
}
