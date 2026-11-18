// P1-8: a relay restart in the middle of typing loses nothing. Alice types into a bound editor
// while the backend stops (data kept), pauses and starts again; afterwards both editors and both
// disks hold the full text.
import { diskText, openFile, setCursor, typeKeys } from "../editor.mjs";
import { sleep, waitFor } from "../obsidian.mjs";

const NAME = "relay-restart";
const NOTE = `Shared/${NAME}/restart.md`;
const SEED = "Restart\n";
const TYPED = " the relay restarts while alice types on; nothing gets lost!";

function texts(v) {
	return v.eval(
		`return app.workspace.getLeavesOfType("markdown")
			.filter((l) => l.view.file?.path === args.path)
			.map((l) => l.view.editor.getValue());`,
		{ path: NOTE },
	);
}

function waitLive(v) {
	return waitFor(
		() =>
			v.eval(
				`return !!app.workspace.activeEditor?.editor?.cm?.dom.classList.contains("teamsync-live");`,
			),
		{ timeout: 15000, label: `${v.name} editor bound` },
	);
}

export default {
	name: NAME,
	needs: ["alice", "bob"],
	seed: { alice: { [NOTE]: SEED } },
	async run({ vaults, step, restartServer }) {
		const { alice, bob } = vaults;
		await waitFor(() => diskText(bob.path, NOTE) === SEED, {
			timeout: 20000,
			label: "bob has restart.md",
		});
		try {
			await openFile(alice, NOTE);
			await openFile(bob, NOTE);
			await Promise.all([waitLive(alice), waitLive(bob)]);
			await setCursor(alice, { line: 0, ch: SEED.length - 1 });

			const typing = typeKeys(alice, TYPED, { cps: 10 });
			await sleep(2000);
			await restartServer({ pauseMs: 3000 });
			await typing;
			step(`alice typed ${TYPED.length} chars at 10 cps; the relay restarted 2 s in`);

			const expected = `Restart${TYPED}\n`;
			await waitFor(
				async () => {
					for (const v of [alice, bob]) {
						const t = await texts(v);
						if (t.length === 0 || t.some((x) => x !== expected)) return false;
						if (diskText(v.path, NOTE) !== expected) return false;
					}
					return true;
				},
				{ timeout: 20000, label: `alice and bob editors and disks == ${JSON.stringify(expected)}` },
			);
			step("both editors and both disks hold the full text after the restart");
		} finally {
			for (const v of [alice, bob]) {
				if (v.running) {
					await v.eval(
						`for (const l of app.workspace.getLeavesOfType("markdown")) l.detach(); return true;`,
					);
				}
			}
		}
	},
};
