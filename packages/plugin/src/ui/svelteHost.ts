import { type Component, mount, unmount } from "svelte";
import { type Readable, writable } from "svelte/store";

/** A Svelte component mounted from TypeScript, with props the host can update. */
export interface MountedComponent<Props extends Record<string, unknown>> {
	/** Assign new prop values; the component re-renders on the next tick. */
	set(patch: Partial<Props>): void;
	/** Remove the component from the DOM. */
	destroy(): void;
}

/** Props shape every host-mounted component receives. */
export interface HostProps<Props extends Record<string, unknown>> {
	/** Named `vm` rather than `state`/`props` so the component's `$vm` auto-subscription
	 * cannot collide with the `$state`/`$props` runes. */
	vm: Readable<Props>;
}

/**
 * Mount a component into `target` with updatable props.
 *
 * Relay's helper puts the props object in a `$state` rune, which requires the
 * file to be compiled by Svelte (`*.svelte.ts`). This host is plain TypeScript —
 * it is imported by `SettingsTab.ts` and by vitest — so reactivity is carried by
 * a store instead, which components read with the usual `$vm` auto-subscription.
 */
export function mountComponent<Props extends Record<string, unknown>>(
	component: Component<HostProps<Props>>,
	options: { target: Element; anchor?: Node; props: Props },
): MountedComponent<Props> {
	let current = options.props;
	const vm = writable(current);
	const instance = mount(component as unknown as Component<Record<string, unknown>>, {
		target: options.target,
		anchor: options.anchor,
		props: { vm },
	});
	return {
		set(patch) {
			current = { ...current, ...patch };
			vm.set(current);
		},
		destroy() {
			void unmount(instance);
		},
	};
}
