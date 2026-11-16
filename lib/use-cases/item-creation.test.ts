import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ backlog: vi.fn(), permission: vi.fn(), itemPermission: vi.fn(), parent: vi.fn(), sprint: vi.fn(), assignable: vi.fn(), create: vi.fn(), publish: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/services/api-read", () => ({ resolveApiBacklog: m.backlog, resolveApiItem: m.parent }));
vi.mock("@/lib/auth/action-authorization", () => ({ requireBacklogPermissionById: m.permission, requireItemPermission: m.itemPermission, requireSprintPermission: m.sprint }));
vi.mock("@/lib/use-cases/guards", async (original) => ({ ...await original<object>(), requireAssignableUser: m.assignable }));
vi.mock("@/lib/services/items", () => ({ createItemWithRequest: m.create }));
vi.mock("@/lib/realtime/publish", () => ({ publishBacklogChange: m.publish }));
import { createExternalItemUseCase } from "./item-creation";
import { currentActivitySource } from "@/lib/auth/actor-context";
const actor = { actorId: "u", source: "mcp" as const, tokenId: "t" };
const input = { backlog: "TEST", type: "epic" as const, title: "Epic", parentKey: "TEST-1", idempotencyKey: "key", sprintId: "s", assigneeId: "a" };
const backlog = { backlogId: "b", resourceId: "b" };
beforeEach(() => {
  vi.resetAllMocks(); m.backlog.mockResolvedValue(backlog); m.permission.mockResolvedValue(backlog);
  m.parent.mockResolvedValue({ id: "p", backlogId: "b" }); m.itemPermission.mockResolvedValue(backlog); m.sprint.mockResolvedValue(backlog);
  m.create.mockImplementation(async (_request, _actorId, prepare) => { await prepare(); return { item: { id: "i", key: "TEST-2" }, replayed: false }; });
});
describe("external creation authorization and replay", () => {
  it("resolves and authorizes mutable inputs only when the transaction prepares a new item", async () => {
    await createExternalItemUseCase(actor, input);
    expect(m.parent).toHaveBeenCalledWith("u", "TEST-1"); expect(m.assignable).toHaveBeenCalled(); expect(m.sprint).toHaveBeenCalled();
    expect(m.publish).toHaveBeenCalledWith(expect.objectContaining({ itemIds: ["i", "p"] }));
  });
  it("rechecks present-field permissions and item visibility on replay without resolving old references or publishing", async () => {
    m.create.mockImplementation(async (_request, _actorId, _prepare, authorizeReplay) => {
      expect(currentActivitySource()).toBe("mcp"); await authorizeReplay({ id: "i", backlogId: "b" });
      return { item: { id: "i", key: "TEST-2", title: "Edited" }, replayed: true };
    });
    expect(await createExternalItemUseCase(actor, input)).toMatchObject({ replayed: true, item: { title: "Edited" } });
    expect(m.permission.mock.calls.map(([call]) => call.permission)).toEqual(["create_items", "schedule_items", "assign_items"]);
    expect(m.itemPermission).toHaveBeenCalledWith({ actorId: "u", itemId: "i", permission: "browse_backlog" });
    for (const mock of [m.parent, m.sprint, m.assignable, m.publish]) expect(mock).not.toHaveBeenCalled();
  });
  it.each(["create_items", "schedule_items", "assign_items"])("refuses a replay after %s is withdrawn", async (permission) => {
    m.permission.mockImplementation(async (check) => { if (check.permission === permission) throw Object.assign(new Error("denied"), { name: "PermissionDeniedError" }); return backlog; });
    await expect(createExternalItemUseCase(actor, input)).rejects.toMatchObject({ name: "PermissionDeniedError" });
    expect(m.create).not.toHaveBeenCalled(); expect(m.publish).not.toHaveBeenCalled();
  });
  it("propagates failure without publishing", async () => {
    m.create.mockRejectedValue(new Error("rollback"));
    await expect(createExternalItemUseCase(actor, input)).rejects.toThrow("rollback"); expect(m.publish).not.toHaveBeenCalled();
  });
});
