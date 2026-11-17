import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { activityAttribution } from "@/lib/auth/actor-context";
import { ResourceNotFoundError } from "@/lib/auth/authorization";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema/auth";
import { backlogs, specActivities, specCreationRequests, specNodes } from "@/lib/db/schema/domain";
import {
  checkSpecMove,
  descendantIds,
  SPEC_TITLE_MAX,
  type SpecMoveError,
  type SpecTreeNode,
} from "@/lib/specs/tree";
import { rankBetween, rankFirst, rankLast } from "@/lib/tree/rank";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type SpecRuleCode =
  | SpecMoveError | "conflict" | "folder_content" | "ambiguous_path"
  | "creation_key_reused" | "creation_key_trashed";

/** The user-facing message of each refused change, shared by the UI, the API and MCP. */
export const SPEC_RULE_MESSAGES: Record<SpecRuleCode, string> = {
  parent_not_found: "Le dossier de destination n’existe plus.",
  parent_not_folder: "Un document ne peut pas contenir d’autres éléments.",
  cycle: "Un dossier ne peut pas être déplacé dans lui-même.",
  conflict: "Ce document a été modifié entre-temps.",
  folder_content: "Un dossier n’a pas de contenu : créez un document.",
  ambiguous_path: "Plusieurs éléments portent ce titre à cet endroit : utilisez leur identifiant.",
  creation_key_reused: "Cette clé de création a déjà été utilisée avec un contenu différent.",
  creation_key_trashed: "L’élément créé avec cette clé a été supprimé. Restaurez-le s’il est dans la corbeille, ou utilisez une nouvelle clé pour une nouvelle création.",
};

/** A tree rule refused the change; its message is the French explanation. */
export class SpecRuleError extends Error {
  constructor(readonly code: SpecRuleCode) {
    super(SPEC_RULE_MESSAGES[code]);
    this.name = "SpecRuleError";
  }
}

/** The document changed since the editor loaded it. */
export class SpecConflictError extends SpecRuleError {
  constructor(readonly current: { content: string; revision: Date }) {
    super("conflict");
    this.name = "SpecConflictError";
  }
}

/**
 * The longest document body, in UTF-8 bytes: it must fit, with its JSON
 * escaping, in a 1 MB API body and in a Server Action (1 MB by default).
 */
export const SPEC_CONTENT_MAX_BYTES = 800_000;

/** A document's Markdown text, bounded in bytes (accents count double). */
export const specContentSchema = z.string().refine(
  (text) => Buffer.byteLength(text, "utf8") <= SPEC_CONTENT_MAX_BYTES,
  { message: "Le document dépasse 800 Ko : découpez-le en plusieurs documents." },
);

const title = z.string().trim().min(1).max(SPEC_TITLE_MAX);

const createInput = z.object({
  backlogId: z.uuid(),
  parentId: z.uuid().nullable(),
  kind: z.enum(["folder", "document"]),
  title,
  // A document may be created with its text (an agent writes it in one call).
  content: specContentSchema.optional(),
}).strict();
const renameInput = z.object({ backlogId: z.uuid(), id: z.uuid(), title }).strict();
const moveInput = z.object({
  backlogId: z.uuid(),
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  // The sibling the node goes right after; null puts it first, absent last.
  afterId: z.uuid().nullable().optional(),
}).strict();
const contentInput = z.object({
  backlogId: z.uuid(),
  id: z.uuid(),
  content: specContentSchema,
  revision: z.coerce.date(),
}).strict();
const nodeUpdateInput = z.object({
  backlogId: z.uuid(),
  id: z.uuid(),
  title: title.optional(),
  content: specContentSchema.optional(),
  revision: z.coerce.date().optional(),
}).strict();
const nodeInput = z.object({ backlogId: z.uuid(), id: z.uuid() }).strict();

/**
 * Next `spec_nodes.updated_at`: transaction time in whole milliseconds and
 * strictly after the previous value, so it serves as the editor's revision.
 */
const nextRevision = () =>
  sql<Date>`greatest(date_trunc('milliseconds', now()), date_trunc('milliseconds', ${specNodes.updatedAt}) + interval '1 millisecond')`;

const treeColumns = {
  id: specNodes.id,
  parentId: specNodes.parentId,
  kind: specNodes.kind,
  title: specNodes.title,
  rank: specNodes.rank,
  updatedAt: specNodes.updatedAt,
};

export type SpecListNode = SpecTreeNode & { updatedAt: Date };

/** Live nodes of a backlog, without document bodies. */
export async function listSpecNodes(backlogId: string): Promise<SpecListNode[]> {
  return db.select(treeColumns).from(specNodes)
    .where(and(eq(specNodes.backlogId, backlogId), isNull(specNodes.deletedAt)))
    .orderBy(asc(specNodes.rank), asc(specNodes.id));
}

export type SpecRootFolder = { id: string; backlogId: string; title: string };

/** Root folders of these backlogs, in tree order (the sidebar lists them). */
export async function listRootSpecFolders(backlogIds: string[]): Promise<SpecRootFolder[]> {
  if (backlogIds.length === 0) return [];
  return db.select({ id: specNodes.id, backlogId: specNodes.backlogId, title: specNodes.title })
    .from(specNodes)
    .where(and(
      inArray(specNodes.backlogId, backlogIds),
      isNull(specNodes.parentId),
      eq(specNodes.kind, "folder"),
      isNull(specNodes.deletedAt),
    ))
    .orderBy(asc(specNodes.rank), asc(specNodes.id));
}

export type SpecDocument = SpecListNode & {
  content: string;
  updatedByName: string | null;
};

/** One live node with its body; null when absent, trashed or in another backlog. */
export async function getSpecNode(backlogId: string, id: string): Promise<SpecDocument | null> {
  const [row] = await db.select({ ...treeColumns, content: specNodes.content, updatedByName: user.name })
    .from(specNodes)
    .leftJoin(user, eq(user.id, specNodes.updatedBy))
    .where(and(eq(specNodes.backlogId, backlogId), eq(specNodes.id, id), isNull(specNodes.deletedAt)))
    .limit(1);
  return row ? { ...row, content: row.content ?? "" } : null;
}

/** Serialises structural changes of one backlog's tree (no concurrent cycle). */
async function lockTree(tx: Tx, backlogId: string) {
  const [backlog] = await tx.select({ id: backlogs.id }).from(backlogs)
    .where(eq(backlogs.id, backlogId)).for("update");
  if (!backlog) throw new ResourceNotFoundError("backlog", backlogId);
  return tx.select({ ...treeColumns, deletedAt: specNodes.deletedAt }).from(specNodes)
    .where(eq(specNodes.backlogId, backlogId));
}

function liveNode<T extends { id: string; deletedAt: Date | null }>(nodes: T[], id: string): T {
  const node = nodes.find((n) => n.id === id && n.deletedAt === null);
  if (!node) throw new ResourceNotFoundError("spec_node", id);
  return node;
}

function assertParent(live: SpecTreeNode[], nodeId: string, parentId: string | null) {
  const error = checkSpecMove(live, nodeId, parentId);
  if (error) throw new SpecRuleError(error);
}

type Journal = {
  nodeId: string;
  backlogId: string;
  action: "create" | "update" | "move" | "delete";
  field?: string;
  oldValue?: string | null;
  newValue?: string | null;
};

async function journal(tx: Tx, actorId: string, rows: Journal[]) {
  if (rows.length === 0) return;
  const attribution = activityAttribution();
  const requestCorrelationId = randomUUID();
  await tx.insert(specActivities).values(rows.map((row) => ({
    ...row, actorId, ...attribution, requestCorrelationId,
  })));
}

export async function createSpecNode(input: unknown, actorId: string) {
  return (await createSpecNodeTransaction(input, actorId)).node;
}

/** An API/MCP idempotency key and the fingerprint of the request it came with. */
export type SpecCreationRequest = { key: string; requestHash: string };

/**
 * Creates a node once per key, like `createItemWithRequest`: a replay with
 * the same key and request returns the node it created, without resolving
 * its parent again (`prepare` runs only for a new creation).
 */
export async function createSpecNodeWithRequest(
  backlogId: string,
  request: SpecCreationRequest | undefined,
  actorId: string,
  prepare: () => Promise<unknown>,
) {
  if (request) {
    const previous = await db.transaction(async (tx) => {
      await lockTree(tx, backlogId);
      return findCreationReplay(tx, backlogId, request, actorId);
    });
    if (previous) return { node: previous, replayed: true };
  }
  const input = createInput.parse(await prepare());
  if (input.backlogId !== backlogId) throw new Error("Inconsistent creation backlog");
  return createSpecNodeTransaction(input, actorId, request);
}

async function findCreationReplay(tx: Tx, backlogId: string, request: SpecCreationRequest, actorId: string) {
  const [previous] = await tx.select().from(specCreationRequests).where(and(
    eq(specCreationRequests.actorId, actorId),
    eq(specCreationRequests.backlogId, backlogId),
    eq(specCreationRequests.key, request.key),
  ));
  if (!previous) return null;
  if (previous.requestHash !== request.requestHash) throw new SpecRuleError("creation_key_reused");
  const [node] = previous.nodeId ? await tx.select({ ...treeColumns, deletedAt: specNodes.deletedAt })
    .from(specNodes)
    .where(and(eq(specNodes.backlogId, backlogId), eq(specNodes.id, previous.nodeId))) : [];
  if (!node || node.deletedAt) throw new SpecRuleError("creation_key_trashed");
  const { deletedAt: _deletedAt, ...live } = node;
  void _deletedAt;
  return live;
}

async function createSpecNodeTransaction(input: unknown, actorId: string, request?: SpecCreationRequest) {
  const data = createInput.parse(input);
  if (data.kind === "folder" && data.content !== undefined) throw new SpecRuleError("folder_content");
  return db.transaction(async (tx) => {
    const nodes = await lockTree(tx, data.backlogId);
    // Checked again under the backlog lock: two concurrent requests with
    // one key create a single node.
    const previous = request ? await findCreationReplay(tx, data.backlogId, request, actorId) : null;
    if (previous) return { node: previous, replayed: true };
    const live = nodes.filter((n) => n.deletedAt === null);
    const id = randomUUID();
    assertParent(live, id, data.parentId);
    // Ranks of trashed siblings count too, so a restore never collides.
    const lastRank = nodes
      .filter((n) => n.parentId === data.parentId)
      .reduce<string | null>((max, n) => (max === null || n.rank > max ? n.rank : max), null);
    const [created] = await tx.insert(specNodes).values({
      id,
      backlogId: data.backlogId,
      parentId: data.parentId,
      kind: data.kind,
      title: data.title,
      content: data.kind === "document" ? data.content ?? "" : null,
      rank: rankLast(lastRank),
      createdBy: actorId,
      updatedBy: actorId,
    }).returning(treeColumns);
    await journal(tx, actorId, [{ nodeId: id, backlogId: data.backlogId, action: "create", newValue: data.title }]);
    if (request) {
      await tx.insert(specCreationRequests).values({
        actorId, backlogId: data.backlogId, key: request.key, requestHash: request.requestHash, nodeId: id,
      });
    }
    return { node: created!, replayed: false };
  });
}

export async function renameSpecNode(input: unknown, actorId: string) {
  const data = renameInput.parse(input);
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ title: specNodes.title }).from(specNodes)
      .where(and(eq(specNodes.backlogId, data.backlogId), eq(specNodes.id, data.id), isNull(specNodes.deletedAt)))
      .for("update");
    if (!current) throw new ResourceNotFoundError("spec_node", data.id);
    if (current.title === data.title) return { changed: false };
    await tx.update(specNodes)
      .set({ title: data.title, updatedBy: actorId, updatedAt: nextRevision() })
      .where(eq(specNodes.id, data.id));
    await journal(tx, actorId, [{
      nodeId: data.id, backlogId: data.backlogId, action: "update", field: "title",
      oldValue: current.title, newValue: data.title,
    }]);
    return { changed: true };
  });
}

export async function moveSpecNode(input: unknown, actorId: string) {
  const data = moveInput.parse(input);
  return db.transaction(async (tx) => {
    const nodes = await lockTree(tx, data.backlogId);
    const live = nodes.filter((n) => n.deletedAt === null);
    const node = liveNode(nodes, data.id);
    assertParent(live, data.id, data.parentId);
    // Trashed siblings keep their place too, as in createSpecNode, so a
    // restore never lands on the rank given to a moved node.
    const order = (a: { rank: string; id: string }, b: { rank: string; id: string }) =>
      a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1;
    const liveSiblings = live.filter((n) => n.parentId === data.parentId).sort(order);
    // No afterId: last, as a new node goes.
    const afterId = data.afterId === undefined
      ? liveSiblings.filter((n) => n.id !== data.id).at(-1)?.id ?? null
      : data.afterId;
    if (afterId !== null) {
      const after = live.find((n) => n.id === afterId);
      if (!after || after.parentId !== data.parentId || after.id === data.id) {
        throw new ResourceNotFoundError("spec_node", afterId);
      }
    }
    if (node.parentId === data.parentId) {
      const position = liveSiblings.findIndex((n) => n.id === data.id);
      const before = position > 0 ? liveSiblings[position - 1]!.id : null;
      if (before === afterId) return { changed: false };
    }
    const siblings = nodes
      .filter((n) => n.parentId === data.parentId && n.id !== data.id)
      .sort(order);
    const index = afterId === null ? -1 : siblings.findIndex((n) => n.id === afterId);
    const prev = index >= 0 ? siblings[index]!.rank : null;
    const next = siblings[index + 1]?.rank ?? null;
    const rank = prev === null
      ? rankFirst(next)
      : next === null || next === prev
        ? rankLast(prev)
        : rankBetween(prev, next);
    await tx.update(specNodes)
      .set({ parentId: data.parentId, rank, updatedBy: actorId })
      .where(eq(specNodes.id, data.id));
    if (node.parentId !== data.parentId) {
      await journal(tx, actorId, [{
        nodeId: data.id, backlogId: data.backlogId, action: "move", field: "parent",
        oldValue: node.parentId, newValue: data.parentId,
      }]);
    }
    return { changed: true };
  });
}

export async function updateSpecContent(input: unknown, actorId: string) {
  const data = contentInput.parse(input);
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ kind: specNodes.kind, content: specNodes.content, updatedAt: specNodes.updatedAt })
      .from(specNodes)
      .where(and(eq(specNodes.backlogId, data.backlogId), eq(specNodes.id, data.id), isNull(specNodes.deletedAt)))
      .for("update");
    if (!current) throw new ResourceNotFoundError("spec_node", data.id);
    if (current.kind !== "document") throw new SpecRuleError("folder_content");
    if (current.updatedAt.getTime() !== data.revision.getTime()) {
      throw new SpecConflictError({ content: current.content ?? "", revision: current.updatedAt });
    }
    if ((current.content ?? "") === data.content) return { revision: current.updatedAt };
    const [updated] = await tx.update(specNodes)
      .set({ content: data.content, updatedBy: actorId, updatedAt: nextRevision() })
      .where(eq(specNodes.id, data.id))
      .returning({ updatedAt: specNodes.updatedAt });
    // The body can be large: the journal records that it changed, not its text.
    await journal(tx, actorId, [{ nodeId: data.id, backlogId: data.backlogId, action: "update", field: "content" }]);
    return { revision: updated!.updatedAt };
  });
}

/**
 * Title and/or text of one node in a single transaction (API, MCP): a stale
 * revision refuses the whole change, title included, and nothing is half done.
 */
export async function updateSpecNode(input: unknown, actorId: string) {
  const data = nodeUpdateInput.parse(input);
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ kind: specNodes.kind, title: specNodes.title, content: specNodes.content, updatedAt: specNodes.updatedAt })
      .from(specNodes)
      .where(and(eq(specNodes.backlogId, data.backlogId), eq(specNodes.id, data.id), isNull(specNodes.deletedAt)))
      .for("update");
    if (!current) throw new ResourceNotFoundError("spec_node", data.id);
    const changes: Journal[] = [];
    const set: Partial<typeof specNodes.$inferInsert> = {};
    if (data.content !== undefined) {
      if (current.kind !== "document") throw new SpecRuleError("folder_content");
      if (!data.revision || current.updatedAt.getTime() !== data.revision.getTime()) {
        throw new SpecConflictError({ content: current.content ?? "", revision: current.updatedAt });
      }
      if ((current.content ?? "") !== data.content) {
        set.content = data.content;
        changes.push({ nodeId: data.id, backlogId: data.backlogId, action: "update", field: "content" });
      }
    }
    if (data.title !== undefined && data.title !== current.title) {
      set.title = data.title;
      changes.push({ nodeId: data.id, backlogId: data.backlogId, action: "update", field: "title", oldValue: current.title, newValue: data.title });
    }
    if (changes.length === 0) return { changed: false };
    await tx.update(specNodes)
      .set({ ...set, updatedBy: actorId, updatedAt: nextRevision() })
      .where(eq(specNodes.id, data.id));
    await journal(tx, actorId, changes);
    return { changed: true };
  });
}

/** Puts a node and its whole subtree in the trash; returns the trashed ids. */
export async function trashSpecNode(input: unknown, actorId: string) {
  const data = nodeInput.parse(input);
  return db.transaction(async (tx) => {
    const nodes = await lockTree(tx, data.backlogId);
    liveNode(nodes, data.id);
    const live = nodes.filter((n) => n.deletedAt === null);
    const ids = descendantIds(live, data.id);
    await tx.update(specNodes).set({ deletedAt: sql`now()`, updatedBy: actorId })
      .where(inArray(specNodes.id, ids));
    await journal(tx, actorId, [{ nodeId: data.id, backlogId: data.backlogId, action: "delete" }]);
    return { ids };
  });
}

/**
 * Brings back a node and the subtree trashed with it (same deletion time).
 * A node whose parent is still in the trash comes back at the root.
 */
export async function restoreSpecNode(input: unknown, actorId: string) {
  const data = nodeInput.parse(input);
  return db.transaction(async (tx) => {
    const nodes = await lockTree(tx, data.backlogId);
    const node = nodes.find((n) => n.id === data.id && n.deletedAt !== null);
    if (!node) throw new ResourceNotFoundError("spec_node", data.id);
    const deletedAt = node.deletedAt!.getTime();
    const batch = nodes.filter((n) => n.deletedAt?.getTime() === deletedAt);
    const ids = descendantIds(batch, data.id);
    const parent = node.parentId === null ? null : nodes.find((n) => n.id === node.parentId);
    const parentLive = parent != null && parent.deletedAt === null;
    await tx.update(specNodes).set({ deletedAt: null, updatedBy: actorId })
      .where(and(inArray(specNodes.id, ids), isNotNull(specNodes.deletedAt)));
    if (!parentLive && node.parentId !== null) {
      await tx.update(specNodes).set({ parentId: null }).where(eq(specNodes.id, data.id));
    }
    await journal(tx, actorId, [{ nodeId: data.id, backlogId: data.backlogId, action: "update", field: "restored" }]);
    return { ids };
  });
}
