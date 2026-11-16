"use server";

import { mapActionAuthorizationError } from "@/lib/auth/action-error";
import { getSession } from "@/lib/auth/session";
import { revalidateBacklogPages } from "@/lib/realtime/publish";
import type { LinkType } from "@/lib/items/links";
import { addLinkUseCase, removeLinkUseCase } from "@/lib/use-cases/links";

async function authenticatedActorId(): Promise<string> {
  const session = await getSession();
  if (!session?.user.id) throw new Error("Forbidden");
  return session.user.id;
}

function mapLinkError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("lui-même")) return "Un item ne peut pas être lié à lui-même.";
  if (msg.includes("introuvable")) return "Item introuvable.";
  if (msg.includes("même backlog")) return "Les deux items doivent appartenir au même backlog.";
  if (msg.includes("existe déjà")) return "Ce lien existe déjà.";
  if (msg.includes("cycle de blocage")) return msg; // surface the full cycle message verbatim
  return "Action impossible sur le lien.";
}

export async function addLinkAction(input: {
  backlogKey: string;
  sourceId: string;
  targetId: string;
  type: LinkType;
}) {
  const actorId = await authenticatedActorId();
  const { backlogKey, sourceId, targetId, type } = input;
  try {
    const link = await addLinkUseCase({ actorId, source: "ui" }, { sourceId, targetId, type });
    revalidateBacklogPages(backlogKey);
    return { ok: true as const, link };
  } catch (e) {
    const authorizationError = mapActionAuthorizationError(e);
    if (authorizationError) return authorizationError;
    return { ok: false as const, error: mapLinkError(e) };
  }
}

export async function removeLinkAction(input: { backlogKey: string; id: string }) {
  const actorId = await authenticatedActorId();
  const { backlogKey, id } = input;
  try {
    await removeLinkUseCase({ actorId, source: "ui" }, id);
    revalidateBacklogPages(backlogKey);
    return { ok: true as const };
  } catch (e) {
    const authorizationError = mapActionAuthorizationError(e);
    if (authorizationError) return authorizationError;
    return { ok: false as const, error: mapLinkError(e) };
  }
}
