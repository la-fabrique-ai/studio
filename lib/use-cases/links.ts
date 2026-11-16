import "server-only";
import { runWithActor, type Actor } from "@/lib/auth/actor-context";
import { requireItemPermission, requireLinkPermission } from "@/lib/auth/action-authorization";
import { ResourceNotFoundError } from "@/lib/auth/authorization";
import { addLinkInput } from "@/lib/items/links";
import { publishBacklogChange } from "@/lib/realtime/publish";
import { addDependency, addLink, getDependencyLink, listDependenciesForItem, removeDependency, removeLink } from "@/lib/services/links";
import { assertSameBacklog } from "@/lib/use-cases/guards";

async function authorizePair(actor: Actor, itemId: string, otherId: string) {
  const item = await requireItemPermission({ actorId: actor.actorId, itemId, permission: "link_items" });
  // Hide a foreign item before checking its write permission, even if browsable.
  const other = await requireItemPermission({ actorId: actor.actorId, itemId: otherId, permission: "browse_backlog" });
  assertSameBacklog(item, other, "item");
  await requireItemPermission({ actorId: actor.actorId, itemId: otherId, permission: "link_items" });
  return item;
}

export async function listDependenciesUseCase(actor: Actor, itemId: string) {
  await requireItemPermission({ actorId: actor.actorId, itemId, permission: "browse_backlog" });
  return listDependenciesForItem(itemId);
}

export async function addDependencyUseCase(actor: Actor, input: { itemId: string; otherId: string; direction: "blocks" | "blocked_by" }) {
  return runWithActor(actor, async () => {
    const item = await authorizePair(actor, input.itemId, input.otherId);
    const result = await addDependency({
      sourceId: input.direction === "blocks" ? input.itemId : input.otherId,
      targetId: input.direction === "blocks" ? input.otherId : input.itemId,
      type: "blocks",
    }, input.itemId, actor.actorId);
    await publishBacklogChange({ kind: "item", backlogId: item.backlogId, itemIds: [input.itemId, input.otherId], actorId: actor.actorId });
    return result;
  });
}

export async function removeDependencyUseCase(actor: Actor, input: { itemId: string; id: string }) {
  return runWithActor(actor, async () => {
    const item = await requireItemPermission({ actorId: actor.actorId, itemId: input.itemId, permission: "link_items" });
    const link = await getDependencyLink(input.itemId, input.id);
    if (!link) throw new ResourceNotFoundError("link", input.id);
    const otherId = link.sourceId === input.itemId ? link.targetId : link.sourceId;
    const other = await requireItemPermission({ actorId: actor.actorId, itemId: otherId, permission: "link_items" });
    assertSameBacklog(item, other, "link");
    await removeDependency(input, actor.actorId);
    await publishBacklogChange({ kind: "item", backlogId: item.backlogId, itemIds: [link.sourceId, link.targetId], actorId: actor.actorId });
    return { removed: true as const };
  });
}

/** Existing UI actions share the authorization, transaction and publication path. */
export async function addLinkUseCase(actor: Actor, input: unknown) {
  const data = addLinkInput.parse(input);
  return runWithActor(actor, async () => {
    const item = await authorizePair(actor, data.sourceId, data.targetId);
    const link = await addLink(data, actor.actorId);
    await publishBacklogChange({ kind: "item", backlogId: item.backlogId, itemIds: [data.sourceId, data.targetId], actorId: actor.actorId });
    return link;
  });
}

export async function removeLinkUseCase(actor: Actor, id: string) {
  return runWithActor(actor, async () => {
    const authorization = await requireLinkPermission({ actorId: actor.actorId, linkId: id, permission: "link_items" });
    const removed = await removeLink(id, actor.actorId);
    if (removed) await publishBacklogChange({ kind: "item", backlogId: authorization.backlogId, itemIds: [removed.sourceId, removed.targetId], actorId: actor.actorId });
    return removed;
  });
}
