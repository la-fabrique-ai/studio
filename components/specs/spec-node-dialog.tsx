"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SPEC_TITLE_MAX } from "@/lib/specs/tree";

export type SpecNodeDialogRequest =
  | { mode: "create"; kind: "folder" | "document"; parentId: string | null; parentTitle: string | null }
  | { mode: "rename"; id: string; kind: "folder" | "document"; title: string };

const HEADINGS = {
  create: { folder: "Nouveau dossier", document: "Nouveau document" },
  rename: { folder: "Renommer le dossier", document: "Renommer le document" },
} as const;

/** Asks for the title of a new folder or document, or a new title. */
export function SpecNodeDialog({
  request,
  onClose,
  onSubmit,
}: {
  request: SpecNodeDialogRequest | null;
  onClose: () => void;
  /** Resolves with an error message to show, or null once done. */
  onSubmit: (title: string) => Promise<string | null>;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {request ? (
        // A fresh form per request: no title left over from the previous one.
        <SpecNodeForm key={JSON.stringify(request)} request={request} onClose={onClose} onSubmit={onSubmit} />
      ) : null}
    </Dialog>
  );
}

function SpecNodeForm({
  request,
  onClose,
  onSubmit,
}: {
  request: SpecNodeDialogRequest;
  onClose: () => void;
  onSubmit: (title: string) => Promise<string | null>;
}) {
  const inputId = useId();
  const errorId = useId();
  const [title, setTitle] = useState(request.mode === "rename" ? request.title : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (title.trim() === "") {
      setError("Le titre ne peut pas être vide.");
      return;
    }
    setBusy(true);
    const message = await onSubmit(title.trim());
    setBusy(false);
    if (message) setError(message);
  }

  return (
    <DialogContent className="sm:max-w-md">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>{HEADINGS[request.mode][request.kind]}</DialogTitle>
          <DialogDescription>
            {request.mode === "create"
              ? request.parentTitle
                ? `Dans « ${request.parentTitle} ».`
                : "À la racine des spécifications."
              : "Le nouveau titre s’affiche dans l’arborescence."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={inputId}>Titre</Label>
          <Input
            id={inputId}
            autoFocus
            value={title}
            maxLength={SPEC_TITLE_MAX}
            onChange={(event) => {
              setTitle(event.target.value);
              setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            placeholder={request.kind === "folder" ? "Ex. Parcours" : "Ex. Contexte et problème"}
          />
          {error ? (
            <p id={errorId} role="alert" className="text-sm text-[var(--danger)]">{error}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
          <Button type="submit" disabled={busy}>
            {request.mode === "create" ? "Créer" : "Renommer"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
