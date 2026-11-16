import "server-only";
import { runWithActor, type Actor } from "@/lib/auth/actor-context";
import { requireBacklogPermissionById, requireItemPermission, requireSprintPermission } from "@/lib/auth/action-authorization";
import { creationRequestHash } from "@/lib/items/creation-request";
import type { CreateItemInput } from "@/lib/mcp/schemas";
import { publishBacklogChange } from "@/lib/realtime/publish";
import { resolveApiBacklog, resolveApiItem } from "@/lib/services/api-read";
import { createItemWithRequest } from "@/lib/services/items";
import { assertSameBacklog, authorizeParent, requireAssignableUser } from "@/lib/use-cases/guards";

/** Shared REST/MCP command: fingerprint before resolving any mutable reference. */
export function createExternalItemUseCase(actor: Actor, input: CreateItemInput) {
  const requestHash = creationRequestHash(input);
  return runWithActor(actor, async () => {
    const { actorId } = actor;
    const backlog = await resolveApiBacklog(actorId, input.backlog);
    const backlogId = backlog.backlogId;
    await requireBacklogPermissionById({ actorId, backlogId, permission: "create_items" });
    // Replays require today's permissions for the original command, but do not
    // resolve its old parent, sprint, status, labels or assignment target.
    if (input.parentKey || input.sprintId) {
      await requireBacklogPermissionById({ actorId, backlogId, permission: "schedule_items" });
    }
    if (input.assigneeId !== undefined) {
      await requireBacklogPermissionById({ actorId, backlogId, permission: "assign_items" });
    }
    let parentId: string | null = null;
    const result = await createItemWithRequest(
      { backlogId, key: input.idempotencyKey, requestHash }, actorId,
      async () => {
        if (input.parentKey) {
          const parent = await resolveApiItem(actorId, input.parentKey);
          assertSameBacklog(backlog, { backlogId: parent.backlogId, resourceId: parent.id }, "item");
          parentId = parent.id;
        }
        await authorizeParent({ actorId, parentId, childBacklog: backlog });
        if (input.sprintId) {
          const sprint = await requireSprintPermission({ actorId, sprintId: input.sprintId, permission: "schedule_items" });
          assertSameBacklog(backlog, sprint, "sprint");
        }
        if (input.assigneeId !== undefined) await requireAssignableUser({ assigneeId: input.assigneeId, backlogId });
        const { backlog: _backlog, parentKey: _parentKey, idempotencyKey: _key, ...fields } = input;
        void _backlog; void _parentKey; void _key;
        return { ...fields, backlogId, parentId };
      },
      async (item) => {
        const readable = await requireItemPermission({ actorId, itemId: item.id, permission: "browse_backlog" });
        assertSameBacklog(backlog, readable, "item");
      },
    );
    if (!result.replayed) {
      await publishBacklogChange({ kind: "item", backlogId, itemIds: [result.item.id, ...(parentId ? [parentId] : [])], actorId });
    }
    return { ...result, backlogId };
  });
}
