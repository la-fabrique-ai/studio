"use server";

import { ZodError } from "zod";
import { mapActionAuthorizationError } from "@/lib/auth/action-error";
import { getSession } from "@/lib/auth/session";
import { revalidateSpecPages } from "@/lib/realtime/publish";
import { SpecConflictError, SpecRuleError } from "@/lib/services/specs";
import {
  createSpecNodeUseCase,
  moveSpecNodeUseCase,
  renameSpecNodeUseCase,
  restoreSpecNodeUseCase,
  trashSpecNodeUseCase,
  updateSpecContentUseCase,
} from "@/lib/use-cases/specs";

/** `backlogKey` only re-renders the pages: a node is authorized through its own backlog. */
type Target = { backlogKey: string; backlogId: string };
type NodeTarget = { backlogKey: string; id: string };
type Failure = { ok: false; error: string };

async function actor() {
  const session = await getSession();
  if (!session?.user.id) throw new Error("Forbidden");
  return { actorId: session.user.id, source: "ui" as const };
}

const TITLE_INVALID = "Le titre doit contenir entre 1 et 200 caractères.";

function failure(error: unknown, fallback: string, invalid: string = fallback): Failure {
  const authorization = mapActionAuthorizationError(error);
  if (authorization) return authorization;
  if (error instanceof SpecRuleError) return { ok: false, error: error.message };
  if (error instanceof ZodError) return { ok: false, error: invalid };
  return { ok: false, error: fallback };
}

export async function createSpecNodeAction(
  input: Target & { parentId: string | null; kind: "folder" | "document"; title: string },
) {
  try {
    const { backlogId, parentId, kind, title } = input;
    const node = await createSpecNodeUseCase(await actor(), { backlogId, parentId, kind, title });
    revalidateSpecPages(input.backlogKey);
    return { ok: true as const, id: node.id };
  } catch (error) {
    return failure(error, input.kind === "folder" ? "Création du dossier impossible." : "Création du document impossible.", TITLE_INVALID);
  }
}

export async function renameSpecNodeAction(input: NodeTarget & { title: string }) {
  try {
    await renameSpecNodeUseCase(await actor(), { id: input.id, title: input.title });
    revalidateSpecPages(input.backlogKey);
    return { ok: true as const };
  } catch (error) {
    return failure(error, "Renommage impossible.", TITLE_INVALID);
  }
}

export async function moveSpecNodeAction(
  input: NodeTarget & { parentId: string | null; afterId: string | null },
) {
  try {
    await moveSpecNodeUseCase(await actor(), { id: input.id, parentId: input.parentId, afterId: input.afterId });
    revalidateSpecPages(input.backlogKey);
    return { ok: true as const };
  } catch (error) {
    return failure(error, "Déplacement impossible.");
  }
}

export async function updateSpecContentAction(
  input: NodeTarget & { content: string; revision: string },
) {
  try {
    // No revalidation: the editor keeps its own state, and re-rendering the
    // page on every autosave would fight the cursor.
    const { id, content, revision: expected } = input;
    const { revision } = await updateSpecContentUseCase(await actor(), { id, content, revision: expected });
    return { ok: true as const, revision: revision.toISOString() };
  } catch (error) {
    if (error instanceof SpecConflictError) {
      return {
        ok: false as const,
        conflict: true as const,
        error: error.message,
        content: error.current.content,
        revision: error.current.revision.toISOString(),
      };
    }
    return failure(error, "Enregistrement impossible.", "Le document est trop long pour être enregistré.");
  }
}

export async function trashSpecNodeAction(input: NodeTarget) {
  try {
    const { ids } = await trashSpecNodeUseCase(await actor(), { id: input.id });
    revalidateSpecPages(input.backlogKey);
    return { ok: true as const, ids };
  } catch (error) {
    return failure(error, "Suppression impossible.");
  }
}

export async function restoreSpecNodeAction(input: NodeTarget) {
  try {
    await restoreSpecNodeUseCase(await actor(), { id: input.id });
    revalidateSpecPages(input.backlogKey);
    return { ok: true as const };
  } catch (error) {
    return failure(error, "Restauration impossible.");
  }
}
