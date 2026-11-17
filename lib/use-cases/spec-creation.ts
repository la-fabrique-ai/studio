import "server-only";
import { findSpecIdInBacklog } from "@/lib/api/specs";
import { runWithActor, type Actor } from "@/lib/auth/actor-context";
import { requireBacklogPermissionById } from "@/lib/auth/action-authorization";
import { creationRequestHash } from "@/lib/items/creation-request";
import { publishBacklogChange } from "@/lib/realtime/publish";
import { resolveApiBacklog } from "@/lib/services/api-read";
import { createSpecNodeWithRequest } from "@/lib/services/specs";

/** A creation as the REST API and MCP receive it: the backlog by key, the parent by id or path. */
export type ExternalSpecCreation = {
  backlog: string;
  parentId?: string | null;
  parentPath?: string;
  kind: "folder" | "document";
  title: string;
  content?: string;
  idempotencyKey?: string;
};

/**
 * Shared REST/MCP command, like `createExternalItemUseCase`: the request is
 * fingerprinted before any reference is resolved, so a replay returns the
 * node it created even after its parent folder was renamed or moved.
 */
export function createExternalSpecUseCase(actor: Actor, input: ExternalSpecCreation) {
  const requestHash = creationRequestHash(input);
  return runWithActor(actor, async () => {
    const { actorId } = actor;
    const { backlogId } = await resolveApiBacklog(actorId, input.backlog);
    // Replays require today's permission too.
    await requireBacklogPermissionById({ actorId, backlogId, permission: "edit_items" });
    const { backlog: _backlog, parentPath, parentId, idempotencyKey, ...fields } = input;
    void _backlog;
    const request = idempotencyKey === undefined ? undefined : { key: idempotencyKey, requestHash };
    const result = await createSpecNodeWithRequest(backlogId, request, actorId, async () => ({
      ...fields,
      backlogId,
      parentId: parentPath ? await findSpecIdInBacklog(backlogId, parentPath) : parentId ?? null,
    }));
    if (!result.replayed) await publishBacklogChange({ kind: "backlog", backlogId, actorId });
    return { ...result, backlogId };
  });
}
