import { beforeEach, expect, it, vi } from "vitest";
import { permissionDeniedError } from "@/test-utils/action-authorization-errors";
const m = vi.hoisted(() => ({ item: vi.fn(), list: vi.fn(), add: vi.fn(), remove: vi.fn(), find: vi.fn(), publish: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/action-authorization", () => ({ requireItemPermission: m.item }));
vi.mock("@/lib/services/links", () => ({ listDependenciesForItem: m.list, addDependency: m.add, removeDependency: m.remove, getDependencyLink: m.find }));
vi.mock("@/lib/realtime/publish", () => ({ publishBacklogChange: m.publish }));
import { currentActorContext } from "@/lib/auth/actor-context";
import { listDependenciesUseCase, addDependencyUseCase, removeDependencyUseCase } from "@/lib/use-cases/links";
const actor = { actorId: "u", source: "mcp" as const, tokenId: "t" };
const input = { itemId: "i", otherId: "j", direction: "blocks" as const };
beforeEach(() => {
  vi.resetAllMocks(); m.item.mockImplementation(async ({ itemId }) => ({ backlogId: "b", resourceId: itemId }));
  m.list.mockResolvedValue([]); m.find.mockResolvedValue({ id: "l", sourceId: "i", targetId: "j", type: "blocks" });
  m.add.mockResolvedValue({ dependency: { id: "l" } }); m.remove.mockResolvedValue({ sourceId: "i", targetId: "j" });
});
it("requires browse permission before listing dependencies", async () => {
  expect(await listDependenciesUseCase(actor, "i")).toEqual([]);
  expect(m.item).toHaveBeenCalledWith({ actorId: "u", itemId: "i", permission: "browse_backlog" });
});
it.each(["blocks", "blocked_by"] as const)("authorizes both endpoints and preserves %s orientation and attribution", async (direction) => {
  m.add.mockImplementation(async () => { expect(currentActorContext()).toEqual(actor); expect(m.publish).not.toHaveBeenCalled(); return { dependency: { id: "l" } }; });
  expect(await addDependencyUseCase(actor, { ...input, direction })).toEqual({ dependency: { id: "l" } });
  expect(m.item.mock.calls.map(([arg]) => arg)).toEqual([
    { actorId: "u", itemId: "i", permission: "link_items" }, { actorId: "u", itemId: "j", permission: "browse_backlog" }, { actorId: "u", itemId: "j", permission: "link_items" },
  ]);
  expect(m.add).toHaveBeenCalledWith({ sourceId: direction === "blocks" ? "i" : "j", targetId: direction === "blocks" ? "j" : "i", type: "blocks" }, "i", "u");
  expect(m.publish).toHaveBeenCalledWith({ kind: "item", backlogId: "b", itemIds: ["i", "j"], actorId: "u" });
});
it.each([0, 1])("refuses missing link_items at endpoint %i without mutation or publication", async (deniedIndex) => {
  m.item.mockImplementation(async ({ itemId, permission }) => { if (permission === "link_items" && itemId === (deniedIndex ? "j" : "i")) throw permissionDeniedError("link_items", { type: "backlog", backlogId: "b" }); return { backlogId: "b", resourceId: itemId }; });
  await expect(addDependencyUseCase(actor, input)).rejects.toMatchObject({ name: "PermissionDeniedError" });
  expect(m.add).not.toHaveBeenCalled(); expect(m.publish).not.toHaveBeenCalled();
});
it("masks another backlog before mutation", async () => {
  m.item.mockResolvedValueOnce({ backlogId: "b", resourceId: "i" }).mockResolvedValueOnce({ backlogId: "foreign", resourceId: "j" });
  await expect(addDependencyUseCase(actor, input)).rejects.toMatchObject({ name: "ResourceNotFoundError" }); expect(m.add).not.toHaveBeenCalled();
});
it("never publishes a failed transaction", async () => {
  m.add.mockRejectedValueOnce(new Error("cycle")); await expect(addDependencyUseCase(actor, input)).rejects.toThrow("cycle"); expect(m.publish).not.toHaveBeenCalled();
});
it("authorizes both stored endpoints before deletion, keeping actor context", async () => {
  m.remove.mockImplementation(async () => { expect(currentActorContext()).toEqual(actor); return { sourceId: "i", targetId: "j" }; });
  expect(await removeDependencyUseCase(actor, { itemId: "i", id: "l" })).toEqual({ removed: true });
  expect(m.find).toHaveBeenCalledWith("i", "l");
  expect(m.item).toHaveBeenCalledWith({ actorId: "u", itemId: "j", permission: "link_items" });
  expect(m.remove).toHaveBeenCalledWith({ itemId: "i", id: "l" }, "u"); expect(m.publish).toHaveBeenCalledTimes(1);
});
it("does not delete a missing, unrelated or non-blocking link", async () => {
  m.find.mockResolvedValueOnce(null);
  await expect(removeDependencyUseCase(actor, { itemId: "i", id: "l" })).rejects.toMatchObject({ name: "ResourceNotFoundError" });
  expect(m.remove).not.toHaveBeenCalled(); expect(m.publish).not.toHaveBeenCalled();
});
it("refuses deletion when the other endpoint denies link_items", async () => {
  m.item.mockResolvedValueOnce({ backlogId: "b", resourceId: "i" }).mockRejectedValueOnce(permissionDeniedError("link_items", { type: "backlog", backlogId: "b" }));
  await expect(removeDependencyUseCase(actor, { itemId: "i", id: "l" })).rejects.toMatchObject({ name: "PermissionDeniedError" }); expect(m.remove).not.toHaveBeenCalled();
});
