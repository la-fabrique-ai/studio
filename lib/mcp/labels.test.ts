import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ backlog: vi.fn(), getBacklog: vi.fn(), item: vi.fn(), list: vi.fn(), create: vi.fn(), add: vi.fn(), remove: vi.fn(), createItem: vi.fn(), updateItem: vi.fn(), summary: vi.fn(), detail: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/action-authorization", () => ({ requireBacklogPermissionByKey: m.backlog }));
vi.mock("@/lib/services/backlogs", () => ({ getBacklogByKeyForUser: m.getBacklog }));
vi.mock("@/lib/services/items", () => ({ getItemByKeyForBacklog: m.item, listActivities: async () => [], listUsersByIds: async () => [] }));
vi.mock("@/lib/services/comments", () => ({ listComments: async () => [] }));
vi.mock("@/lib/services/api-read", () => ({ getApiItemDetail: m.detail }));
vi.mock("@/lib/services/item-search", () => ({ findItemSummaryByKey: m.summary, InvalidCursorError: class extends Error {} }));
vi.mock("@/lib/use-cases/labels", () => ({ listLabelsUseCase: m.list, createLabelUseCase: m.create, addItemLabelUseCase: m.add, removeItemLabelUseCase: m.remove }));
vi.mock("@/lib/use-cases/items", () => ({ createItemUseCase: m.createItem, updateItemUseCase: m.updateItem }));
import { JIROO_TOOLS, runTool, type ToolDefinition } from "@/lib/mcp/tools";
const labelId = "11111111-1111-4111-8111-111111111111";
const label = { id: labelId, backlogId: null, name: "Global", color: "--label-1" };
const reader = { actorId: "u", tokenId: "t", scope: "read" as const };
const writer = { ...reader, scope: "write" as const };
function tool(name: string): ToolDefinition {
  const found = JIROO_TOOLS.find((candidate) => candidate.name === name);
  expect(found, `${name} is registered`).toBeDefined(); return found!;
}
beforeEach(() => {
  vi.resetAllMocks();
  m.backlog.mockResolvedValue({ backlogId: "b" }); m.getBacklog.mockResolvedValue({ id: "b", key: "TEST" });
  m.item.mockResolvedValue({ id: "i", key: "TEST-1", backlogId: "b" }); m.summary.mockResolvedValue({ key: "TEST-1" });
  m.list.mockResolvedValue([label]); m.create.mockResolvedValue({ label, created: false });
  m.add.mockResolvedValue({ changed: true }); m.remove.mockResolvedValue({ changed: false });
  m.createItem.mockResolvedValue({ item: { id: "i", key: "TEST-1" } });
});
describe("MCP labels", () => {
  it("lists global and local labels with read scope", async () => {
    const result = await runTool(tool("list_labels"), { backlog: "test" }, reader);
    expect(result.structuredContent).toEqual({ labels: [label] });
    expect(m.list).toHaveBeenCalledWith({ actorId: "u", tokenId: "t", source: "mcp" }, "b");
  });
  it("returns a reused global label with created:false", async () => {
    const result = await runTool(tool("create_label"), { backlog: "test", name: " Global " }, writer);
    expect(result.structuredContent).toEqual({ label, created: false });
    expect(m.create).toHaveBeenCalledWith({ actorId: "u", tokenId: "t", source: "mcp" }, { backlogId: "b", name: "Global" });
  });
  it.each(["add_item_label", "remove_item_label"])("%s reports whether anything changed", async (name) => {
    const result = await runTool(tool(name), { key: "test-1", labelId }, writer);
    expect(result.structuredContent).toEqual({ changed: name === "add_item_label" });
    expect(name === "add_item_label" ? m.add : m.remove).toHaveBeenCalledWith({ actorId: "u", tokenId: "t", source: "mcp" }, { itemId: "i", labelId });
  });
  it.each(["create_label", "add_item_label", "remove_item_label", "create_item"])("refuses a read token on %s", async (name) => {
    const result = await runTool(tool(name), { backlog: "TEST", name: "x", key: "TEST-1", labelId, type: "composant", title: "x", labelIds: [labelId] }, reader);
    expect(result.isError).toBe(true); expect(result.content[0]!.text).toContain("lecture seule");
    expect(m.backlog).not.toHaveBeenCalled(); expect(m.item).not.toHaveBeenCalled();
  });
  it.each(["add_item_label", "remove_item_label"])("%s hides foreign and unknown labels identically", async (name) => {
    const results = [];
    for (const reason of ["foreign", "unknown"]) {
      (name === "add_item_label" ? m.add : m.remove).mockRejectedValueOnce(Object.assign(new Error(reason), { name: "ResourceNotFoundError" }));
      results.push(await runTool(tool(name), { key: "TEST-1", labelId }, writer));
    }
    expect(results[0]).toEqual(results[1]); expect(results[0]?.isError).toBe(true);
  });
  it("deduplicates initial labels in create_item", async () => {
    const result = await runTool(tool("create_item"), { backlog: "TEST", type: "composant", title: "x", labelIds: [labelId, labelId] }, writer);
    expect(result.isError).toBeUndefined(); expect(m.createItem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ labelIds: [labelId] }));
  });
  it("includes children and labels from the REST reader, retaining MCP comment aliases", async () => {
    const child = { id: "child", key: "TEST-2", title: "Child", statusId: labelId };
    const comments = [
      { id: "c", body: "hello", updatedAt: "2026-11-16T08:00:00.000Z", deletedAt: null },
      { id: "d", body: "", updatedAt: null, deletedAt: "2026-11-16T09:00:00.000Z" },
    ];
    m.detail.mockResolvedValue({ key: "TEST-1", children: [child], labels: [label], comments, activities: [] });
    const result = await runTool(tool("get_item"), { key: "TEST-1" }, reader);
    expect(result.structuredContent).toEqual({ item: { key: "TEST-1", children: [child], labels: [label], activities: [], comments: [
      { ...comments[0], editedAt: "2026-11-16T08:00:00.000Z", deleted: false },
      { ...comments[1], editedAt: null, deleted: true },
    ] } });
  });
  it.each([{ backlog: "TEST", name: "x", color: "red" }, { backlog: "TEST", name: " " }])("rejects invalid or unknown catalogue fields", async (input) => {
    expect((await runTool(tool("create_label"), input, writer)).isError).toBe(true); expect(m.create).not.toHaveBeenCalled();
  });
});

it("normalizes and deduplicates replacement labels in update_item", async () => {
  const id = "abcdef12-abcd-4abc-8abc-abcdef123456";
  const result = await runTool(tool("update_item"), { key: "TEST-1", labelIds: [id.toUpperCase(), id] }, writer);
  expect(result.isError).toBeUndefined();
  expect(m.updateItem).toHaveBeenCalledWith(expect.anything(), { id: "i", labelIds: [id] });
});
it.each(["create_item", "update_item"])("%s masks foreign and unknown labels identically", async (name) => {
  const results = [];
  for (const reason of ["foreign", "unknown"]) {
    (name === "create_item" ? m.createItem : m.updateItem).mockRejectedValueOnce(Object.assign(new Error(reason), { name: "ResourceNotFoundError", resourceType: "label" }));
    results.push(await runTool(tool(name), name === "create_item" ? { backlog: "TEST", type: "composant", title: "x", labelIds: [labelId] } : { key: "TEST-1", labelIds: [labelId] }, writer));
  }
  expect(results[0]).toEqual(results[1]);
  expect(results[0]?.isError).toBe(true);
  expect(results[0]?.content[0]?.text).toBe("Introuvable, ou hors de vos droits de lecture.");
});
