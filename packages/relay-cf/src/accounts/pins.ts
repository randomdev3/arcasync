/** 6-digit invite and reset PINs from the crypto RNG (4-digit ones issued earlier stay valid). */

/** A uniform `000000`–`999999` (rejection sampling over 32-bit values, so no digit bias). */
export function randomPin(): string {
	const limit = 4_294_000_000; // the largest multiple of 1 000 000 below 2^32
	for (;;) {
		for (const v of crypto.getRandomValues(new Uint32Array(4))) {
			if (v < limit) return String(v % 1_000_000).padStart(6, "0");
		}
	}
}

/** A PIN for which `taken` is false; null if none was found in `tries` draws. */
export function newPin(taken: (pin: string) => boolean, tries = 200): string | null {
	for (let i = 0; i < tries; i++) {
		const pin = randomPin();
		if (!taken(pin)) return pin;
	}
	return null;
}
