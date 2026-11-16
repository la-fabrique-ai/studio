"use server";

import { ZodError } from "zod";
import { mapActionAuthorizationError } from "@/lib/auth/action-error";
import { getSession } from "@/lib/auth/session";
import { invalidateSpecs } from "@/lib/realtime/publish";
import { SpecConflictError, SpecRuleError } from "@/lib/services/specs";
import {
  createSpecNodeUseCase,
  moveSpecNodeUseCase,
  renameSpecNodeUseCase,
  restoreSpecNodeUseCase,
  trashSpecNodeUseCase,
  updateSpecContentUseCase,
} from "@/lib/use-cases/specs";

type Target = { backlogKey: string; backlogId: string };
type Failure = { ok: false; error: string };

const RULE_MESSAGES: Record<string, string> = {
  parent_not_found: "Le dossier de destination n’existe plus.",
  parent_not_folder: "Un document ne peut pas contenir d’autres éléments.",
  cycle: "Un dossier ne peut pas être déplacé dans lui-même.",
};

async function actor() {
  const session = await getSession();
  if (!session?.user.id) throw new Error("Forbidden");
  return { actorId: session.user.id, source: "ui" as const };
}

const TITLE_INVALID = "Le titre doit contenir entre 1 et 200 caractères.";

function failure(error: unknown, fallback: string, invalid: string = fallback): Failure {
  const authorization = mapActionAuthorizationError(error);
  if (authorization) return authorization;
  if (error instanceof SpecRuleError) return { ok: false, error: RULE_MESSAGES[error.code] ?? fallback };
  if (error instanceof ZodError) return { ok: false, error: invalid };
  return { ok: false, error: fallback };
}

/** The use case's input: the key only serves to re-render the pages. */
function scoped<T extends Target>(input: T): Omit<T, "backlogKey"> {
  const copy: Partial<T> = { ...input };
  delete copy.backlogKey;
  return copy as Omit<T, "backlogKey">;
}

function invalidate(target: Target, actorId: string) {
  return invalidateSpecs(target.backlogKey, { backlogId: target.backlogId, actorId });
}

export async function createSpecNodeAction(
  input: Target & { parentId: string | null; kind: "folder" | "document"; title: string },
) {
  try {
    const who = await actor();
    const node = await createSpecNodeUseCase(who, scoped(input));
    await invalidate(input, who.actorId);
    return { ok: true as const, id: node.id };
  } catch (error) {
    return failure(error, input.kind === "folder" ? "Création du dossier impossible." : "Création du document impossible.", TITLE_INVALID);
  }
}

export async function renameSpecNodeAction(input: Target & { id: string; title: string }) {
  try {
    const who = await actor();
    await renameSpecNodeUseCase(who, scoped(input));
    await invalidate(input, who.actorId);
    return { ok: true as const };
  } catch (error) {
    return failure(error, "Renommage impossible.", TITLE_INVALID);
  }
}

export async function moveSpecNodeAction(
  input: Target & { id: string; parentId: string | null; afterId: string | null },
) {
  try {
    const who = await actor();
    await moveSpecNodeUseCase(who, scoped(input));
    await invalidate(input, who.actorId);
    return { ok: true as const };
  } catch (error) {
    return failure(error, "Déplacement impossible.");
  }
}

export async function updateSpecContentAction(
  input: Target & { id: string; content: string; revision: string },
) {
  try {
    // No revalidation: the editor keeps its own state, and re-rendering the
    // page on every autosave would fight the cursor.
    const { backlogId, id, content, revision: expected } = input;
    const { revision } = await updateSpecContentUseCase(await actor(), { backlogId, id, content, revision: expected });
    return { ok: true as const, revision: revision.toISOString() };
  } catch (error) {
    if (error instanceof SpecConflictError) {
      return {
        ok: false as const,
        conflict: true as const,
        error: "Ce document a été modifié entre-temps.",
        content: error.current.content,
        revision: error.current.revision.toISOString(),
      };
    }
    return failure(error, "Enregistrement impossible.", "Le document est trop long pour être enregistré.");
  }
}

export async function trashSpecNodeAction(input: Target & { id: string }) {
  try {
    const who = await actor();
    const { ids } = await trashSpecNodeUseCase(who, scoped(input));
    await invalidate(input, who.actorId);
    return { ok: true as const, ids };
  } catch (error) {
    return failure(error, "Suppression impossible.");
  }
}

export async function restoreSpecNodeAction(input: Target & { id: string }) {
  try {
    const who = await actor();
    await restoreSpecNodeUseCase(who, scoped(input));
    await invalidate(input, who.actorId);
    return { ok: true as const };
  } catch (error) {
    return failure(error, "Restauration impossible.");
  }
}
