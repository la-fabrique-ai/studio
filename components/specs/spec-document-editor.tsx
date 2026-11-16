"use client";

import { useCallback, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { updateSpecContentAction } from "@/app/actions/specs";
import { MarkdownEditor } from "@/components/markdown/markdown-editor";
import { MARKDOWN_PROSE } from "@/components/markdown/prose";
import type { SaveResult } from "@/lib/autosave/scheduler";
import { useAutosave } from "@/lib/autosave/use-autosave";

/** Pause in typing before the document is saved. */
const AUTOSAVE_DELAY_MS = 900;
const PLACEHOLDER = "Écrivez, ou tapez « / » pour insérer un bloc…";

type Props = {
  backlogKey: string;
  backlogId: string;
  id: string;
  currentUserId: string;
  content: string;
  /** Server revision of `content` (ISO time of the last write). */
  revision: string;
  readOnly: boolean;
};

/**
 * A specification document edited in place like a page: saved automatically
 * after a pause in typing and on blur. Each save carries the revision it was
 * based on; if someone saved in between, the server version is offered
 * instead of overwriting it.
 */
export function SpecDocumentEditor(props: Props) {
  // Another user or document is another draft: never reuse one across them.
  return <SpecDocumentEditorBody key={`${props.currentUserId}:${props.id}`} {...props} />;
}

type Conflict = { content: string; revision: string };

function SpecDocumentEditorBody({ backlogKey, backlogId, id, currentUserId, content, revision, readOnly }: Props) {
  const base = useRef(revision);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const save = useCallback(async (next: string): Promise<SaveResult> => {
    try {
      const result = await updateSpecContentAction({ backlogKey, backlogId, id, content: next, revision: base.current });
      if (result.ok) {
        base.current = result.revision;
        return { ok: true, revision: Date.parse(result.revision) };
      }
      if ("conflict" in result) setConflict({ content: result.content, revision: result.revision });
      return { ok: false, error: result.error };
    } catch {
      return { ok: false, error: "Le serveur est injoignable." };
    }
  }, [backlogKey, backlogId, id]);

  const autosave = useAutosave({
    user: currentUserId,
    key: `spec-document:${currentUserId}:${id}`,
    initial: content,
    revision: Date.parse(revision),
    save,
    delay: AUTOSAVE_DELAY_MS,
  });
  // A draft kept from a previous mount (unsaved) wins over the server value.
  const [value, setValue] = useState(() =>
    autosave.adopt(content, Date.parse(revision)) ? content : autosave.current(),
  );

  function onChange(next: string) {
    setValue(next);
    autosave.change(next);
  }

  function takeServerVersion() {
    if (!conflict) return;
    autosave.discard();
    base.current = conflict.revision;
    autosave.adopt(conflict.content, Date.parse(conflict.revision));
    setValue(conflict.content);
    setConflict(null);
  }

  async function keepMine() {
    if (!conflict) return;
    // Overwrite deliberately: rebase the pending draft on the server revision.
    base.current = conflict.revision;
    setConflict(null);
    await autosave.retry();
  }

  if (readOnly) {
    return content.trim() === "" ? (
      <p className="text-sm text-muted-foreground">Ce document est vide.</p>
    ) : (
      <div className={MARKDOWN_PROSE}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }

  const failed = autosave.status === "error";
  return (
    <div className="flex flex-col gap-2">
      {conflict ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--warning)] bg-[var(--surface-2)] px-3 py-2 text-sm">
          <span className="flex-1">Ce document a été modifié par quelqu’un d’autre pendant que vous écriviez.</span>
          <button type="button" onClick={takeServerVersion} className="rounded px-2 py-1 font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none">
            Afficher leur version
          </button>
          <button type="button" onClick={() => void keepMine()} className="rounded px-2 py-1 font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none">
            Garder la mienne
          </button>
        </div>
      ) : null}
      <MarkdownEditor
        variant="page"
        label="Contenu du document"
        placeholder={PLACEHOLDER}
        minHeightClassName="min-h-[50vh]"
        invalid={failed}
        value={value}
        onChange={onChange}
        onBlur={() => void autosave.flush()}
        fallback={
          value ? (
            <div className={MARKDOWN_PROSE}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
            </div>
          ) : (
            <p className="min-h-[50vh] text-sm text-muted-foreground">{PLACEHOLDER}</p>
          )
        }
      />
      <p aria-live="polite" className="min-h-5 text-right text-xs text-muted-foreground">
        {autosave.status === "saving" ? "Enregistrement…" : null}
        {autosave.status === "saved" && !autosave.pending ? "Enregistré" : null}
        {failed && !conflict ? (
          <>
            <span className="text-[var(--danger)]">Échec de l’enregistrement{autosave.error ? ` : ${autosave.error}` : null}</span>{" "}
            <button type="button" onClick={() => void autosave.retry()} className="font-medium text-foreground underline-offset-2 hover:underline">
              Réessayer
            </button>
          </>
        ) : null}
      </p>
    </div>
  );
}
