import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissionDeniedError } from "@/test-utils/action-authorization-errors";
const m = vi.hoisted(() => ({ backlog: vi.fn(), item: vi.fn(), list: vi.fn(), create: vi.fn(), delta: vi.fn(), publish: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/action-authorization", () => ({ requireBacklogPermissionById: m.backlog, requireItemPermission: m.item }));
vi.mock("@/lib/services/items", () => ({ listLabelsForBacklog: m.list }));
vi.mock("@/lib/services/labels", () => ({ createLabelWithResult: m.create, setItemLabel: m.delta }));
vi.mock("@/lib/realtime/publish", () => ({ publishBacklogChange: m.publish }));
import { currentActorContext } from "@/lib/auth/actor-context";
import { addItemLabelUseCase, createLabelUseCase, listLabelsUseCase, removeItemLabelUseCase } from "@/lib/use-cases/labels";
const actor = { actorId: "u", source: "api" as const, tokenId: "t" };
const input = { itemId: "i", labelId: "l" };
beforeEach(() => {
  vi.resetAllMocks(); m.backlog.mockResolvedValue({ backlogId: "b" }); m.item.mockResolvedValue({ backlogId: "b" });
  m.create.mockResolvedValue({ label: { id: "l" }, created: true }); m.delta.mockResolvedValue({ changed: true }); m.list.mockResolvedValue([]);
});
describe("authorized label use cases", () => {
  it("requires browse_backlog to read the catalogue", async () => {
    await expect(listLabelsUseCase(actor, "b")).resolves.toEqual([]);
    expect(m.backlog).toHaveBeenCalledWith({ actorId: "u", backlogId: "b", permission: "browse_backlog" });
  });
  it("creates with edit_items and publishes only a newly created catalogue entry", async () => {
    await createLabelUseCase(actor, { backlogId: "b", name: "Urgent" });
    expect(m.backlog).toHaveBeenCalledWith({ actorId: "u", backlogId: "b", permission: "edit_items" });
    expect(m.publish).toHaveBeenCalledWith({ kind: "backlog", backlogId: "b", actorId: "u" });
    m.publish.mockClear(); m.create.mockResolvedValue({ label: { id: "l" }, created: false });
    await createLabelUseCase(actor, { backlogId: "b", name: "Urgent" }); expect(m.publish).not.toHaveBeenCalled();
  });
  it.each([addItemLabelUseCase, removeItemLabelUseCase])("authorizes the item and keeps source/token attribution during a delta", async (useCase) => {
    m.delta.mockImplementation(async () => { expect(currentActorContext()).toEqual(actor); return { changed: true }; });
    await expect(useCase(actor, input)).resolves.toEqual({ changed: true });
    expect(m.item).toHaveBeenCalledWith({ actorId: "u", itemId: "i", permission: "edit_items" });
    expect(m.delta).toHaveBeenCalledWith({ ...input, backlogId: "b", present: useCase === addItemLabelUseCase }, "u", expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(m.publish).toHaveBeenCalledWith({ kind: "item", backlogId: "b", itemIds: ["i"], actorId: "u" });
  });
  it.each([addItemLabelUseCase, removeItemLabelUseCase])("does not publish a no-op or a failed transaction", async (useCase) => {
    m.delta.mockResolvedValue({ changed: false }); await useCase(actor, input); expect(m.publish).not.toHaveBeenCalled();
    m.delta.mockRejectedValueOnce(new Error("rollback")); await expect(useCase(actor, input)).rejects.toThrow("rollback"); expect(m.publish).not.toHaveBeenCalled();
  });
  it.each(["create", "add", "remove"])("refuses %s before mutating when edit_items is missing", async (kind) => {
    const error = permissionDeniedError("edit_items", { type: "backlog", backlogId: "b" });
    m.backlog.mockRejectedValue(error); m.item.mockRejectedValue(error);
    const result = kind === "create" ? createLabelUseCase(actor, { backlogId: "b", name: "x" }) : kind === "add" ? addItemLabelUseCase(actor, input) : removeItemLabelUseCase(actor, input);
    await expect(result).rejects.toBe(error); expect(m.create).not.toHaveBeenCalled(); expect(m.delta).not.toHaveBeenCalled(); expect(m.publish).not.toHaveBeenCalled();
  });
  it("publishes after the service transaction has resolved", async () => {
    let finish!: (value: { changed: boolean }) => void;
    m.delta.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = addItemLabelUseCase(actor, input);
    await vi.waitFor(() => expect(m.delta).toHaveBeenCalled()); expect(m.publish).not.toHaveBeenCalled();
    finish({ changed: true }); await pending; expect(m.publish).toHaveBeenCalledOnce();
  });
});
