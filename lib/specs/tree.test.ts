import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  buildSpecTree,
  checkSpecMove,
  DEFAULT_SPEC_FOLDERS,
  descendantIds,
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
