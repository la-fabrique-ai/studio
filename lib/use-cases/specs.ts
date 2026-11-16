import "server-only";
import { runWithActor, type Actor } from "@/lib/auth/actor-context";
import { requireBacklogPermissionById } from "@/lib/auth/action-authorization";
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
// reads them, whoever edits its items edits them (no new permission).
const read = (actor: Actor, backlogId: string) =>
  requireBacklogPermissionById({ actorId: actor.actorId, backlogId, permission: "browse_backlog" });
const write = (actor: Actor, backlogId: string) =>
  requireBacklogPermissionById({ actorId: actor.actorId, backlogId, permission: "edit_items" });

export async function listSpecNodesUseCase(actor: Actor, backlogId: string) {
  await read(actor, backlogId);
  return listSpecNodes(backlogId);
}

export async function getSpecNodeUseCase(actor: Actor, backlogId: string, id: string) {
  await read(actor, backlogId);
  return getSpecNode(backlogId, id);
}

type Scoped = { backlogId: string };

function writing<I extends Scoped, R>(run: (input: I, actorId: string) => Promise<R>) {
  return (actor: Actor, input: I) =>
    runWithActor(actor, async () => {
      await write(actor, input.backlogId);
      return run(input, actor.actorId);
    });
}

export const createSpecNodeUseCase = writing(
  (input: Scoped & { parentId: string | null; kind: "folder" | "document"; title: string }, actorId) =>
    createSpecNode(input, actorId),
);
export const renameSpecNodeUseCase = writing(
  (input: Scoped & { id: string; title: string }, actorId) => renameSpecNode(input, actorId),
);
export const moveSpecNodeUseCase = writing(
  (input: Scoped & { id: string; parentId: string | null; afterId: string | null }, actorId) =>
    moveSpecNode(input, actorId),
);
export const updateSpecContentUseCase = writing(
  (input: Scoped & { id: string; content: string; revision: string }, actorId) =>
    updateSpecContent(input, actorId),
);
export const trashSpecNodeUseCase = writing(
  (input: Scoped & { id: string }, actorId) => trashSpecNode(input, actorId),
);
export const restoreSpecNodeUseCase = writing(
  (input: Scoped & { id: string }, actorId) => restoreSpecNode(input, actorId),
);
