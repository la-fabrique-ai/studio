import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpecTree } from "@/components/specs/spec-tree";
import type { SpecTreeNode } from "@/lib/specs/tree";

const m = vi.hoisted(() => ({
  create: vi.fn(), rename: vi.fn(), move: vi.fn(), trash: vi.fn(), restore: vi.fn(),
  push: vi.fn(), refresh: vi.fn(), params: {} as { id?: string },
}));
vi.mock("@/app/actions/specs", () => ({
  createSpecNodeAction: m.create,
  renameSpecNodeAction: m.rename,
  moveSpecNodeAction: m.move,
  trashSpecNodeAction: m.trash,
  restoreSpecNodeAction: m.restore,
}));
vi.mock("next/navigation", () => ({
  useParams: () => m.params,
  useRouter: () => ({ push: m.push, refresh: m.refresh }),
}));

const BRIEF = "00000000-0000-4000-8000-000000000001";
const PRD = "00000000-0000-4000-8000-000000000002";
const DOC = "00000000-0000-4000-8000-000000000003";
const SUB = "00000000-0000-4000-8000-000000000004";
const DEEP = "00000000-0000-4000-8000-000000000005";
const nodes: SpecTreeNode[] = [
  { id: PRD, parentId: null, kind: "folder", title: "PRD", rank: "a1" },
  { id: BRIEF, parentId: null, kind: "folder", title: "Brief", rank: "a0" },
  { id: DOC, parentId: BRIEF, kind: "document", title: "Contexte", rank: "a0" },
  { id: SUB, parentId: PRD, kind: "folder", title: "Stories", rank: "a0" },
  { id: DEEP, parentId: SUB, kind: "document", title: "Story 1", rank: "a0" },
];

const renderTree = (canEdit = true) =>
  render(<SpecTree backlogKey="ATL" backlogId="backlog-1" nodes={nodes} canEdit={canEdit} />);

beforeEach(() => {
  vi.resetAllMocks();
  m.params = {};
});

describe("SpecTree", () => {
  it("lists root folders in rank order, open, with links to each node", () => {
    renderTree();
    const nav = screen.getByRole("navigation", { name: "Arborescence des spécifications" });
    const links = within(nav).getAllByRole("link").map((link) => link.textContent);
    // Root folders start open; a nested folder starts closed.
    expect(links).toEqual(["Brief", "Contexte", "PRD", "Stories"]);
    expect(screen.getByRole("link", { name: "Contexte" })).toHaveAttribute("href", `/b/ATL/specs/${DOC}`);
  });

  it("opens and closes a folder", async () => {
    renderTree();
    await userEvent.click(screen.getByRole("button", { name: "Déplier Stories" }));
    expect(screen.getByRole("link", { name: "Story 1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Replier Stories" }));
    expect(screen.queryByRole("link", { name: "Story 1" })).not.toBeInTheDocument();
  });

  it("opens the path to the current document and marks it", () => {
    m.params = { id: DEEP };
    renderTree();
    expect(screen.getByRole("link", { name: "Story 1" })).toHaveAttribute("aria-current", "page");
  });

  it("creates a document in a folder from its menu, then opens it", async () => {
    m.create.mockResolvedValue({ ok: true, id: "new-doc" });
    renderTree();
    await userEvent.click(screen.getByRole("button", { name: "Actions sur Brief" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Nouveau document/ }));
    const dialog = await screen.findByRole("dialog", { name: "Nouveau document" });
    await userEvent.type(within(dialog).getByLabelText("Titre"), "Objectifs");
    await userEvent.click(within(dialog).getByRole("button", { name: "Créer" }));
    expect(m.create).toHaveBeenCalledWith({
      backlogKey: "ATL", backlogId: "backlog-1", parentId: BRIEF, kind: "document", title: "Objectifs",
    });
    expect(m.push).toHaveBeenCalledWith("/b/ATL/specs/new-doc");
  });

  it("shows the server's refusal in the dialog", async () => {
    m.create.mockResolvedValue({ ok: false, error: "Création du dossier impossible." });
    renderTree();
    await userEvent.click(screen.getByRole("button", { name: "Nouveau dossier à la racine" }));
    const dialog = await screen.findByRole("dialog", { name: "Nouveau dossier" });
    await userEvent.type(within(dialog).getByLabelText("Titre"), "Archives");
    await userEvent.click(within(dialog).getByRole("button", { name: "Créer" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Création du dossier impossible.");
  });

  it("renames from the row menu", async () => {
    m.rename.mockResolvedValue({ ok: true });
    renderTree();
    await userEvent.click(screen.getByRole("button", { name: "Actions sur PRD" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Renommer/ }));
    const input = within(await screen.findByRole("dialog")).getByLabelText("Titre");
    await userEvent.clear(input);
    await userEvent.type(input, "Exigences{Enter}");
    expect(m.rename).toHaveBeenCalledWith({ backlogKey: "ATL", backlogId: "backlog-1", id: PRD, title: "Exigences" });
  });

  it("deletes a document and leaves its page when it was open", async () => {
    m.params = { id: DOC };
    m.trash.mockResolvedValue({ ok: true, ids: [DOC] });
    renderTree();
    await userEvent.click(screen.getByRole("button", { name: "Actions sur Contexte" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Supprimer/ }));
    await vi.waitFor(() => expect(m.push).toHaveBeenCalledWith("/b/ATL/specs"));
    expect(m.trash).toHaveBeenCalledWith({ backlogKey: "ATL", backlogId: "backlog-1", id: DOC });
  });

  it("offers no editing to a reader", () => {
    renderTree(false);
    expect(screen.queryByRole("button", { name: /Actions sur/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Nouveau/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Brief" })).toBeInTheDocument();
  });
});

describe("SpecTree navigation", () => {
  it("reveals a nested node opened from elsewhere", () => {
    const { rerender } = renderTree();
    expect(screen.queryByRole("link", { name: "Story 1" })).not.toBeInTheDocument();
    m.params = { id: DEEP };
    rerender(<SpecTree backlogKey="ATL" backlogId="backlog-1" nodes={nodes} canEdit />);
    expect(screen.getByRole("link", { name: "Story 1" })).toHaveAttribute("aria-current", "page");
  });
});
