import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissionDeniedError } from "@/test-utils/action-authorization-errors";
const m = vi.hoisted(() => ({
  session: vi.fn(), revalidate: vi.fn(), create: vi.fn(), content: vi.fn(), move: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/realtime/publish", () => ({ revalidateSpecPages: m.revalidate }));
vi.mock("@/lib/auth/session", () => ({ getSession: m.session }));
vi.mock("@/lib/use-cases/specs", () => ({
  createSpecNodeUseCase: m.create,
  updateSpecContentUseCase: m.content,
  moveSpecNodeUseCase: m.move,
  renameSpecNodeUseCase: vi.fn(),
  restoreSpecNodeUseCase: vi.fn(),
  trashSpecNodeUseCase: vi.fn(),
}));
import { createSpecNodeAction, moveSpecNodeAction, updateSpecContentAction } from "@/app/actions/specs";
import { SpecConflictError, SpecRuleError } from "@/lib/services/specs";

const target = { backlogKey: "ATL", backlogId: "backlog-1" };
beforeEach(() => {
  vi.resetAllMocks();
  m.session.mockResolvedValue({ user: { id: "writer-1" } });
});

describe("specification actions", () => {
  it("creates through the authorized use case and revalidates the specs pages", async () => {
    m.create.mockResolvedValue({ id: "node-1" });
    await expect(createSpecNodeAction({ ...target, parentId: null, kind: "document", title: "Brief" }))
      .resolves.toEqual({ ok: true, id: "node-1" });
    expect(m.create).toHaveBeenCalledWith(
      { actorId: "writer-1", source: "ui" },
      { backlogId: "backlog-1", parentId: null, kind: "document", title: "Brief" },
    );
    expect(m.revalidate).toHaveBeenCalledWith("ATL");
  });

  it("returns a permission denial without revalidating", async () => {
    m.create.mockRejectedValueOnce(permissionDeniedError("edit_items", { type: "backlog", backlogId: "backlog-1" }));
    const result = await createSpecNodeAction({ ...target, parentId: null, kind: "folder", title: "X" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("permission") });
    expect(m.revalidate).not.toHaveBeenCalled();
  });

  it("explains a refused move in French", async () => {
    m.move.mockRejectedValueOnce(new SpecRuleError("cycle"));
    await expect(moveSpecNodeAction({ backlogKey: "ATL", id: "a", parentId: "b", afterId: null }))
      .resolves.toEqual({ ok: false, error: "Un dossier ne peut pas être déplacé dans lui-même." });
  });

  it("returns the new revision of a saved document, without revalidating", async () => {
    m.content.mockResolvedValue({ revision: new Date("2026-11-16T10:00:00.000Z") });
    await expect(updateSpecContentAction({ backlogKey: "ATL", id: "doc", content: "# A", revision: "2026-11-16T09:00:00.000Z" }))
      .resolves.toEqual({ ok: true, revision: "2026-11-16T10:00:00.000Z" });
    expect(m.revalidate).not.toHaveBeenCalled();
  });

  it("explains an invalid document without blaming the title", async () => {
    const { ZodError } = await import("zod");
    m.content.mockRejectedValueOnce(new ZodError([]));
    await expect(updateSpecContentAction({ backlogKey: "ATL", id: "doc", content: "x", revision: "2026-11-16T09:00:00.000Z" }))
      .resolves.toEqual({ ok: false, error: "Le document est trop long pour être enregistré." });
  });

  it("hands back the server version on a conflict", async () => {
    m.content.mockRejectedValueOnce(new SpecConflictError({ content: "serveur", revision: new Date("2026-11-16T11:00:00.000Z") }));
    await expect(updateSpecContentAction({ backlogKey: "ATL", id: "doc", content: "local", revision: "2026-11-16T09:00:00.000Z" }))
      .resolves.toEqual({
        ok: false, conflict: true, error: "Ce document a été modifié entre-temps.",
        content: "serveur", revision: "2026-11-16T11:00:00.000Z",
      });
  });
});

describe("node actions", () => {
  it("authorize a node through its own backlog, never one the browser names", async () => {
    m.move.mockResolvedValue({ changed: true, backlogId: "backlog-1" });
    await moveSpecNodeAction({ backlogKey: "ATL", id: "a", parentId: null, afterId: null });
    expect(m.move).toHaveBeenCalledWith({ actorId: "writer-1", source: "ui" }, { id: "a", parentId: null, afterId: null });
    expect(m.revalidate).toHaveBeenCalledWith("ATL");
  });
});
