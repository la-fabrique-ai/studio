import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpecDocumentEditor } from "@/components/specs/spec-document-editor";

vi.mock("@/app/actions/specs", () => ({ updateSpecContentAction: vi.fn() }));

const props = {
  backlogKey: "ATL",
  backlogId: "backlog-1",
  id: "doc-1",
  currentUserId: "reader-1",
  revision: "2026-11-16T10:00:00.000Z",
};

describe("SpecDocumentEditor", () => {
  it("renders the Markdown for a reader, without an editor", () => {
    render(<SpecDocumentEditor {...props} readOnly content={"# Problème\n\nLes quotas."} />);
    expect(screen.getByRole("heading", { name: "Problème" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("says when a reader opens an empty document", () => {
    render(<SpecDocumentEditor {...props} readOnly content="  " />);
    expect(screen.getByText("Ce document est vide.")).toBeInTheDocument();
  });

  it("shows the content while the editor loads for a writer", () => {
    render(<SpecDocumentEditor {...props} readOnly={false} content="## Objectif" />);
    expect(screen.getByRole("heading", { name: "Objectif" })).toBeInTheDocument();
  });
});
