import "server-only";
import { randomUUID } from "node:crypto";
import { runWithActor, type Actor } from "@/lib/auth/actor-context";
import { requireBacklogPermissionById, requireItemPermission } from "@/lib/auth/action-authorization";
import { publishBacklogChange } from "@/lib/realtime/publish";
import { listLabelsForBacklog } from "@/lib/services/items";
import { createLabelWithResult, setItemLabel } from "@/lib/services/labels";

export async function listLabelsUseCase(actor: Actor, backlogId: string) {
  await requireBacklogPermissionById({ actorId: actor.actorId, backlogId, permission: "browse_backlog" });
  return listLabelsForBacklog(backlogId);
}

export async function createLabelUseCase(actor: Actor, input: { backlogId: string; name: string }) {
  return runWithActor(actor, async () => {
    await requireBacklogPermissionById({ actorId: actor.actorId, backlogId: input.backlogId, permission: "edit_items" });
    const result = await createLabelWithResult(input);
    if (result.created) await publishBacklogChange({ kind: "backlog", backlogId: input.backlogId, actorId: actor.actorId });
    return result;
  });
}

type ItemLabelInput = { itemId: string; labelId: string };
async function changeItemLabel(actor: Actor, input: ItemLabelInput, present: boolean) {
  return runWithActor(actor, async () => {
    const item = await requireItemPermission({ actorId: actor.actorId, itemId: input.itemId, permission: "edit_items" });
    const result = await setItemLabel({ ...input, backlogId: item.backlogId, present }, actor.actorId, randomUUID());
    if (result.changed) await publishBacklogChange({ kind: "item", backlogId: item.backlogId, itemIds: [input.itemId], actorId: actor.actorId });
    return result;
  });
}
export function addItemLabelUseCase(actor: Actor, input: ItemLabelInput) {
  return changeItemLabel(actor, input, true);
}
export function removeItemLabelUseCase(actor: Actor, input: ItemLabelInput) {
  return changeItemLabel(actor, input, false);
}
