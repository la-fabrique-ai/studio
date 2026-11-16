import "server-only";
import { runWithActor, type Actor } from "@/lib/auth/actor-context";
import { requireBacklogPermissionById, requireSpecNodePermission } from "@/lib/auth/action-authorization";
import type { BacklogPermissionKey } from "@/lib/auth/permissions";
import { publishBacklogChange } from "@/lib/realtime/publish";
import {
  createSpecNode,
  getSpecNode,
  listSpecNodes,
  moveSpecNode,
  renameSpecNode,
  restoreSpecNode,
  trashSpecNode,
  updateSpecContent,
} from "@/lib/services/specs";

// Specifications reuse the item permissions: whoever browses the backlog
// reads them, whoever edits its items edits them (no new permission). A node
// is always authorized through its own backlog, never one the caller names.
const READ: BacklogPermissionKey = "browse_backlog";
const WRITE: BacklogPermissionKey = "edit_items";

const backlogFor = (actor: Actor, backlogId: string, permission: BacklogPermissionKey) =>
  requireBacklogPermissionById({ actorId: actor.actorId, backlogId, permission });
const nodeFor = (actor: Actor, nodeId: string, permission: BacklogPermissionKey) =>
  requireSpecNodePermission({ actorId: actor.actorId, nodeId, permission });

/** Other open tabs refresh their tree (and the sidebar folders). */
const publish = (actor: Actor, backlogId: string) =>
  publishBacklogChange({ kind: "backlog", backlogId, actorId: actor.actorId });

export async function listSpecNodesUseCase(actor: Actor, backlogId: string) {
  await backlogFor(actor, backlogId, READ);
  return listSpecNodes(backlogId);
}

/** A live node with its body and its backlog; null when it is in the trash. */
export async function getSpecNodeUseCase(actor: Actor, id: string) {
  const { backlogId } = await nodeFor(actor, id, READ);
  const node = await getSpecNode(backlogId, id);
  return node ? { ...node, backlogId } : null;
}

export function createSpecNodeUseCase(
  actor: Actor,
  input: { backlogId: string; parentId: string | null; kind: "folder" | "document"; title: string; content?: string },
) {
  return runWithActor(actor, async () => {
    await backlogFor(actor, input.backlogId, WRITE);
    const node = await createSpecNode(input, actor.actorId);
    await publish(actor, input.backlogId);
    return { ...node, backlogId: input.backlogId };
  });
}

/**
 * Writes one node after authorizing it through its own backlog, then lets
 * the other tabs refresh (`publishFromUi: false` keeps UI writes silent).
 */
async function writeNode<R>(
  actor: Actor,
  id: string,
  run: (backlogId: string) => Promise<R>,
  { publishFromUi = true }: { publishFromUi?: boolean } = {},
): Promise<R & { backlogId: string }> {
  return runWithActor(actor, async () => {
    const { backlogId } = await nodeFor(actor, id, WRITE);
    const result = await run(backlogId);
    if (publishFromUi || actor.source !== "ui") await publish(actor, backlogId);
    return { ...result, backlogId };
  });
}

export function renameSpecNodeUseCase(actor: Actor, input: { id: string; title: string }) {
  return writeNode(actor, input.id, (backlogId) => renameSpecNode({ ...input, backlogId }, actor.actorId));
}

export function moveSpecNodeUseCase(actor: Actor, input: { id: string; parentId: string | null; afterId: string | null }) {
  return writeNode(actor, input.id, (backlogId) => moveSpecNode({ ...input, backlogId }, actor.actorId));
}

/**
 * Each autosave of the editor would refresh every reader: only an agent's
 * write (API, MCP) is published, so people watch the document fill in.
 */
export function updateSpecContentUseCase(actor: Actor, input: { id: string; content: string; revision: string }) {
  return writeNode(actor, input.id, (backlogId) => updateSpecContent({ ...input, backlogId }, actor.actorId), {
    publishFromUi: false,
  });
}

export function trashSpecNodeUseCase(actor: Actor, input: { id: string }) {
  return writeNode(actor, input.id, (backlogId) => trashSpecNode({ ...input, backlogId }, actor.actorId));
}

export function restoreSpecNodeUseCase(actor: Actor, input: { id: string }) {
  return writeNode(actor, input.id, (backlogId) => restoreSpecNode({ ...input, backlogId }, actor.actorId));
}
