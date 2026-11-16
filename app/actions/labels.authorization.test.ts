import { beforeEach, expect, it, vi } from "vitest";
import { permissionDeniedError } from "@/test-utils/action-authorization-errors";

const m = vi.hoisted(() => ({ authorize: vi.fn(), create: vi.fn(), revalidate: vi.fn(), publish: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => ({ user: { id: "reader" } }) }));
vi.mock("@/lib/auth/action-authorization", () => ({ requireBacklogPermissionById: m.authorize }));
vi.mock("@/lib/services/labels", () => ({ createLabelWithResult: m.create }));
vi.mock("@/lib/services/items", () => ({ listLabelsForBacklog: vi.fn() }));
vi.mock("@/lib/realtime/publish", () => ({ revalidateBacklogPages: m.revalidate, publishBacklogChange: m.publish }));
// The action and its use case are real; only authorization and side effects are substituted.
import { createLabelAction } from "@/app/actions/labels";
beforeEach(() => {
  vi.resetAllMocks();
  m.authorize.mockImplementation(async ({ permission }) => {
    if (permission === "edit_items") throw permissionDeniedError("edit_items", { type: "backlog", backlogId: "b" });
    return { backlogId: "b" };
  });
  m.create.mockResolvedValue({ label: { id: "l" }, created: true });
});
it("refuses catalogue creation without edit_items through the real use case", async () => {
  await expect(createLabelAction({ backlogKey: "TEST", backlogId: "b", name: "Urgent" })).resolves.toEqual({
    ok: false, error: "Vous n’avez pas la permission « Modifier les éléments » pour ce backlog.",
  });
  expect(m.create).not.toHaveBeenCalled();
  expect(m.revalidate).not.toHaveBeenCalled();
  expect(m.publish).not.toHaveBeenCalled();
});
