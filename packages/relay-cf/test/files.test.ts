import { type FileMeta, INDEX_FILES } from "@teamsync/shared";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { FILES_TABLE, listFiles, projectFiles, referencedChunks } from "../src/files";
import { memorySql } from "./sqlite";

const meta = (id: string, extra: Partial<FileMeta> = {}): FileMeta => ({
	id,
	kind: "md",
	updatedBy: "u1",
	updatedAt: 1000,
	...extra,
});

function setup() {
	const { sql, transaction } = memorySql();
	sql.exec(FILES_TABLE);
	const index = new Y.Doc();
	const files = index.getMap<unknown>(INDEX_FILES);
	const project = () => projectFiles(sql, transaction, Y.encodeStateAsUpdate(index));
	return { sql, files, project };
}

describe("projectFiles", () => {
	it("writes only the rows that differ", () => {
		const { sql, files, project } = setup();
		for (let i = 0; i < 50; i++) files.set(`n${i}.md`, meta(`f${i}`));
		expect(project()).toEqual({ upserts: 50, deletes: 0, rowsWritten: 50 });
		expect(project()).toEqual({ upserts: 0, deletes: 0, rowsWritten: 0 });

		// Paths are the keys, so a rename is 1 upsert + 1 delete; plus a delete and an edit.
		files.delete("n1.md");
		files.set("renamed.md", meta("f1"));
		files.delete("n2.md");
		files.set("n3.md", meta("f3", { updatedAt: 2000 }));
		expect(project()).toEqual({ upserts: 2, deletes: 2, rowsWritten: 4 });
		const rows = listFiles(sql);
		expect(rows).toHaveLength(49);
		expect(rows.find((r) => r.path === "renamed.md")).toEqual({
			path: "renamed.md",
			...meta("f1"),
		});
		expect(rows.find((r) => r.path === "n3.md")?.updatedAt).toBe(2000);
	});

	it("skips malformed entries", () => {
		const { sql, files, project } = setup();
		files.set("ok.md", meta("f1"));
		files.set("bad.md", { id: 7 });
		files.set("worse.md", "nope");
		expect(project()).toMatchObject({ upserts: 1, deletes: 0 });
		expect(listFiles(sql).map((r) => r.path)).toEqual(["ok.md"]);
	});

	it("round-trips binary meta and collects referenced chunks", () => {
		const { sql, files, project } = setup();
		const bin = meta("b1", {
			kind: "binary",
			hash: "h",
			size: 3,
			mime: "image/png",
			chunks: ["c1", "c2"],
		});
		files.set("a.png", bin);
		files.set("b.png", meta("b2", { kind: "binary", chunks: ["c2", "c3"] }));
		files.set("c.md", meta("m1"));
		project();
		expect(listFiles(sql).find((r) => r.path === "a.png")).toEqual({ path: "a.png", ...bin });
		expect(referencedChunks(sql)).toEqual(new Set(["c1", "c2", "c3"]));
		expect(project().rowsWritten).toBe(0);
	});
});
