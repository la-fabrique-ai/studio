import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  node: vi.fn(), backlog: vi.fn(), publish: vi.fn(), content: vi.fn(), rename: vi.fn(), create: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/action-authorization", () => ({
  requireSpecNodePermission: m.node,
  requireBacklogPermissionById: m.backlog,
}));
vi.mock("@/lib/realtime/publish", () => ({ publishBacklogChange: m.publish }));
vi.mock("@/lib/services/specs", () => ({
  updateSpecContent: m.content, renameSpecNode: m.rename, createSpecNode: m.create,
  getSpecNode: vi.fn(), listSpecNodes: vi.fn(), moveSpecNode: vi.fn(), restoreSpecNode: vi.fn(), trashSpecNode: vi.fn(),
}));
import { createSpecNodeUseCase, renameSpecNodeUseCase, updateSpecContentUseCase } from "@/lib/use-cases/specs";

const ui = { actorId: "u-1", source: "ui" as const };
const mcp = { actorId: "u-1", source: "mcp" as const, tokenId: "t-1" };

beforeEach(() => {
  vi.resetAllMocks();
  m.node.mockResolvedValue({ backlogId: "backlog-of-node", resourceId: "n-1" });
  m.content.mockResolvedValue({ revision: new Date(0) });
  m.rename.mockResolvedValue({ changed: true });
  m.create.mockResolvedValue({ id: "n-2" });
});

describe("specification use cases", () => {
  it("write a node in its own backlog, after checking edit_items there", async () => {
    await renameSpecNodeUseCase(ui, { id: "n-1", title: "PRD" });
    expect(m.node).toHaveBeenCalledWith({ actorId: "u-1", nodeId: "n-1", permission: "edit_items" });
    expect(m.rename).toHaveBeenCalledWith({ id: "n-1", title: "PRD", backlogId: "backlog-of-node" }, "u-1");
  });

  it("publish tree changes to the other tabs", async () => {
    await renameSpecNodeUseCase(ui, { id: "n-1", title: "PRD" });
    expect(m.publish).toHaveBeenCalledWith({ kind: "backlog", backlogId: "backlog-of-node", actorId: "u-1" });
    await createSpecNodeUseCase(mcp, { backlogId: "b-1", parentId: null, kind: "folder", title: "X" });
    expect(m.backlog).toHaveBeenCalledWith({ actorId: "u-1", backlogId: "b-1", permission: "edit_items" });
    expect(m.publish).toHaveBeenLastCalledWith({ kind: "backlog", backlogId: "b-1", actorId: "u-1" });
  });

  it("publish a document's text only when an agent wrote it, not on each autosave", async () => {
    await updateSpecContentUseCase(ui, { id: "n-1", content: "a", revision: "2026-11-16T10:00:00.000Z" });
    expect(m.publish).not.toHaveBeenCalled();
    await updateSpecContentUseCase(mcp, { id: "n-1", content: "b", revision: "2026-11-16T10:00:00.000Z" });
    expect(m.publish).toHaveBeenCalledTimes(1);
  });

  it("write nothing when the node is refused", async () => {
    m.node.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "PermissionDeniedError" }));
    await expect(renameSpecNodeUseCase(ui, { id: "n-1", title: "PRD" })).rejects.toThrow("denied");
    expect(m.rename).not.toHaveBeenCalled();
    expect(m.publish).not.toHaveBeenCalled();
  });
});
