import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ backlog: vi.fn(), getBacklog: vi.fn(), item: vi.fn(), list: vi.fn(), add: vi.fn(), remove: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/action-authorization", () => ({ requireBacklogPermissionByKey: m.backlog }));
vi.mock("@/lib/services/backlogs", () => ({ getBacklogByKeyForUser: m.getBacklog }));
vi.mock("@/lib/services/items", () => ({ getItemByKeyForBacklog: m.item }));
vi.mock("@/lib/use-cases/links", () => ({ listDependenciesUseCase: m.list, addDependencyUseCase: m.add, removeDependencyUseCase: m.remove }));
import { JIROO_TOOLS, runTool, type ToolDefinition } from "@/lib/mcp/tools";
const id = "abcdef12-abcd-4abc-8abc-abcdef123456";
const dependency = { id, direction: "blocked_by", sourceKey: "TEST-2", targetKey: "TEST-1", other: { id: "j", key: "TEST-2", title: "Other", status: { id: "s", name: "Done", category: "done" } } };
const reader = { actorId: "u", tokenId: "t", scope: "read" as const }; const writer = { ...reader, scope: "write" as const };
const actor = { actorId: "u", tokenId: "t", source: "mcp" };
function tool(name: string): ToolDefinition { const found = JIROO_TOOLS.find((t) => t.name === name); expect(found, `${name} registered`).toBeDefined(); return found!; }
beforeEach(() => {
  vi.resetAllMocks(); m.backlog.mockResolvedValue({ backlogId: "b" }); m.getBacklog.mockResolvedValue({ id: "b", key: "TEST" });
  m.item.mockImplementation(async (key) => ({ id: key === "TEST-1" ? "i" : "j", key, backlogId: "b" }));
  m.list.mockResolvedValue([dependency]); m.add.mockResolvedValue({ dependency }); m.remove.mockResolvedValue({ removed: true });
});
it("lists with read scope and returns the neighbour state", async () => {
  const response = await runTool(tool("list_dependencies"), { key: "test-1" }, reader);
  expect(response.structuredContent).toEqual({ dependencies: [dependency] }); expect(m.list).toHaveBeenCalledWith(actor, "i");
});
it.each(["blocks", "blocked_by"])("adds a dependency in the %s direction", async (direction) => {
  const response = await runTool(tool("add_dependency"), { key: "test-1", otherKey: " test-2 ", direction }, writer);
  expect(response.structuredContent).toEqual({ dependency }); expect(m.add).toHaveBeenCalledWith(actor, { itemId: "i", otherId: "j", direction });
});
it("removes a dependency using a normalized UUID", async () => {
  const response = await runTool(tool("remove_dependency"), { key: "TEST-1", id: id.toUpperCase() }, writer);
  expect(response.structuredContent).toEqual({ removed: true }); expect(m.remove).toHaveBeenCalledWith(actor, { itemId: "i", id });
});
it.each(["add_dependency", "remove_dependency"])("refuses read tokens on %s before resolving resources", async (name) => {
  const response = await runTool(tool(name), { key: "TEST-1", otherKey: "TEST-2", direction: "blocks", id }, reader);
  expect(response.isError).toBe(true); expect(response.content[0]!.text).toContain("lecture seule"); expect(m.item).not.toHaveBeenCalled();
});
it("refuses self links and unknown fields", async () => {
  for (const input of [{ key: "TEST-1", otherKey: "test-1", direction: "blocks" }, { key: "TEST-1", otherKey: "TEST-2", direction: "blocks", extra: true }]) {
    expect((await runTool(tool("add_dependency"), input, writer)).isError).toBe(true);
  }
  expect(m.add).not.toHaveBeenCalled();
});
it.each(["list_dependencies", "add_dependency", "remove_dependency"])("%s masks invisible and missing resources identically", async (name) => {
  const results = [];
  for (const message of ["hidden", "unknown"]) {
    m.item.mockRejectedValueOnce(Object.assign(new Error(message), { name: "ResourceNotFoundError" }));
    results.push(await runTool(tool(name), name === "add_dependency" ? { key: "TEST-1", otherKey: "TEST-2", direction: "blocks" } : name === "remove_dependency" ? { key: "TEST-1", id } : { key: "TEST-1" }, writer));
  }
  expect(results[0]).toEqual(results[1]); expect(results[0]?.isError).toBe(true);
});
it("returns public domain errors for cycles and duplicates", async () => {
  for (const message of ["Ce lien existe déjà.", "Impossible d'ajouter ce lien : il créerait un cycle de blocage."]) {
    m.add.mockRejectedValueOnce(new Error(message));
    const response = await runTool(tool("add_dependency"), { key: "TEST-1", otherKey: "TEST-2", direction: "blocks" }, writer);
    expect(response.isError).toBe(true); expect(response.content[0]!.text).toBe(message);
  }
});
