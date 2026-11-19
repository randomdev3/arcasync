/** 4-digit invite PINs from the crypto RNG. */

/** A uniform `0000`–`9999` (rejection sampling over 16-bit values, so no digit bias). */
export function randomPin(): string {
	const limit = 60_000; // the largest multiple of 10 000 below 2^16
	for (;;) {
		for (const v of crypto.getRandomValues(new Uint16Array(8))) {
			if (v < limit) return String(v % 10_000).padStart(4, "0");
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
