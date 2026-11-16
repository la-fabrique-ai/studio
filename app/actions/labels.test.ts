import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissionDeniedError } from "@/test-utils/action-authorization-errors";
const m = vi.hoisted(() => ({ create: vi.fn(), session: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSession: m.session }));
vi.mock("@/lib/use-cases/labels", () => ({ createLabelUseCase: m.create }));
vi.mock("@/lib/realtime/publish", () => ({ revalidateBacklogPages: m.revalidate, invalidateBacklog: vi.fn() }));
import { createLabelAction } from "@/app/actions/labels";
beforeEach(() => { vi.resetAllMocks(); m.session.mockResolvedValue({ user: { id: "writer-1" } }); });
describe("label catalogue action", () => {
  it("uses the shared authorized use case and revalidates the page", async () => {
    m.create.mockResolvedValue({ label: { id: "label-1" }, created: true });
    await expect(createLabelAction({ backlogKey: "TEST", backlogId: "backlog-1", name: "Urgent" })).resolves.toEqual({ ok: true, label: { id: "label-1" } });
    expect(m.create).toHaveBeenCalledWith({ actorId: "writer-1", source: "ui" }, { backlogId: "backlog-1", name: "Urgent" });
    expect(m.revalidate).toHaveBeenCalledWith("TEST");
  });
  it("returns a structured permission denial without revalidating", async () => {
    m.create.mockRejectedValueOnce(permissionDeniedError("edit_items", { type: "backlog", backlogId: "backlog-1" }));
    await expect(createLabelAction({ backlogKey: "TEST", backlogId: "backlog-1", name: "Urgent" })).resolves.toEqual({ ok: false, error: "Vous n’avez pas la permission « Modifier les éléments » pour ce backlog." });
    expect(m.revalidate).not.toHaveBeenCalled();
  });
});
