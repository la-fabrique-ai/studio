import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  buildSpecTree,
  checkSpecMove,
  DEFAULT_SPEC_FOLDERS,
  descendantIds,
  findSpecByPath,
  flattenSpecTree,
  type SpecTreeNode,
} from "./tree";

const node = (id: string, parentId: string | null, rank: string, kind: "folder" | "document" = "folder"): SpecTreeNode => ({
  id, parentId, rank, kind, title: id,
});

// brief/
//   context.md
//   research/
//     interviews.md
// prd/
const nodes = [
  node("prd", null, "a1"),
  node("brief", null, "a0"),
  node("research", "brief", "a1"),
  node("context", "brief", "a0", "document"),
  node("interviews", "research", "a0", "document"),
];

describe("buildSpecTree", () => {
  it("nests children under their parent, ordered by rank", () => {
    const tree = buildSpecTree(nodes);
    expect(tree.map((n) => n.id)).toEqual(["brief", "prd"]);
    expect(tree[0]!.children.map((n) => n.id)).toEqual(["context", "research"]);
    expect(tree[0]!.children[1]!.children.map((n) => n.id)).toEqual(["interviews"]);
  });

  it("breaks rank ties by id so the order is stable", () => {
    const tree = buildSpecTree([node("b", null, "a0"), node("a", null, "a0")]);
    expect(tree.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("drops nodes whose parent is missing (in the trash)", () => {
    const tree = buildSpecTree([node("orphan", "gone", "a0"), node("root", null, "a0")]);
    expect(tree.map((n) => n.id)).toEqual(["root"]);
  });
});

describe("descendantIds", () => {
  it("lists the whole subtree, the node included", () => {
    expect(descendantIds(nodes, "brief").sort()).toEqual(["brief", "context", "interviews", "research"]);
    expect(descendantIds(nodes, "prd")).toEqual(["prd"]);
  });
});

describe("ancestorsOf", () => {
  it("returns the path from the root down to the node", () => {
    expect(ancestorsOf(nodes, "interviews").map((n) => n.id)).toEqual(["brief", "research", "interviews"]);
  });

  it("returns an empty path for an unknown node", () => {
    expect(ancestorsOf(nodes, "nope")).toEqual([]);
  });
});

describe("checkSpecMove", () => {
  it("accepts a move to the root or under another folder", () => {
    expect(checkSpecMove(nodes, "research", null)).toBeNull();
    expect(checkSpecMove(nodes, "context", "prd")).toBeNull();
  });

  it("refuses a document as parent", () => {
    expect(checkSpecMove(nodes, "research", "context")).toBe("parent_not_folder");
  });

  it("refuses a move under itself or its own subtree", () => {
    expect(checkSpecMove(nodes, "brief", "brief")).toBe("cycle");
    expect(checkSpecMove(nodes, "brief", "research")).toBe("cycle");
  });

  it("refuses an unknown parent", () => {
    expect(checkSpecMove(nodes, "context", "nope")).toBe("parent_not_found");
  });
});

describe("DEFAULT_SPEC_FOLDERS", () => {
  it("are the BMAD folders, in order", () => {
    expect(DEFAULT_SPEC_FOLDERS).toEqual(["Brief", "PRD", "UX"]);
  });
});

describe("flattenSpecTree and spec paths", () => {
  it("lists nodes in tree order with their slash-separated path", () => {
    expect(flattenSpecTree(nodes).map((n) => [n.id, n.path])).toEqual([
      ["brief", "brief"],
      ["context", "brief/context"],
      ["research", "brief/research"],
      ["interviews", "brief/research/interviews"],
      ["prd", "prd"],
    ]);
  });
});

describe("findSpecByPath", () => {
  const titled = [
    node("b", null, "a0"), node("p", null, "a1"),
    { ...node("s", "p", "a0"), title: "Stories" },
    { ...node("d", "s", "a0", "document"), title: "Story 1" },
  ].map((n) => (n.id === "b" ? { ...n, title: "Brief" } : n.id === "p" ? { ...n, title: "PRD" } : n));

  it("follows titles from the root, ignoring case, spaces and slashes at the ends", () => {
    expect(findSpecByPath(titled, "PRD/Stories/Story 1")).toEqual({ ok: true, id: "d" });
    expect(findSpecByPath(titled, " /prd/ stories /")).toEqual({ ok: true, id: "s" });
  });

  it("says when nothing or several nodes match", () => {
    expect(findSpecByPath(titled, "PRD/Nope")).toEqual({ ok: false, reason: "not_found" });
    expect(findSpecByPath(titled, "")).toEqual({ ok: false, reason: "not_found" });
    // Two titles match « story 1 » without any exact match: no guess.
    const twins = [...titled, { ...node("d2", "s", "a1", "document"), title: "STORY 1" }];
    expect(findSpecByPath(twins, "PRD/Stories/story 1")).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("prefers an exact title over a case-insensitive one", () => {
    const twins = [...titled, { ...node("d2", "s", "a1", "document"), title: "story 1" }];
    expect(findSpecByPath(twins, "PRD/Stories/story 1")).toEqual({ ok: true, id: "d2" });
  });
});
