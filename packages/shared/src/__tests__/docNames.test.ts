import { describe, expect, it } from "vitest";
import { docName, parseDocName } from "../docNames.js";

describe("docNames", () => {
	it("round-trips index and file docs", () => {
		expect(docName({ workspaceId: "w1", kind: "index" })).toBe("ws:w1:index");
		expect(docName({ workspaceId: "w1", kind: "md", fileId: "f1" })).toBe("ws:w1:md:f1");
		expect(parseDocName("ws:w1:index")).toEqual({ workspaceId: "w1", kind: "index" });
		expect(parseDocName("ws:w1:xd:f9")).toEqual({ workspaceId: "w1", kind: "xd", fileId: "f9" });
	});
	it("rejects bad names", () => {
		expect(parseDocName("foo")).toBeNull();
		expect(parseDocName("ws:w1:index:x")).toBeNull();
		expect(parseDocName("ws:w1:bogus:f1")).toBeNull();
		expect(parseDocName("ws:w1:md:../x")).toBeNull();
		expect(() => docName({ workspaceId: "a:b", kind: "index" })).toThrow();
	});
});
