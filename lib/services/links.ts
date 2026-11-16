import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { activityAttribution } from "@/lib/auth/actor-context";
import { ResourceNotFoundError } from "@/lib/auth/authorization";
import type { Dependency } from "@/lib/api/dto";
import { db } from "@/lib/db";
import { activities, backlogs, itemLinks, items, statuses } from "@/lib/db/schema/domain";
import { addLinkInput, isDuplicateLink, LINK_TYPE_META } from "@/lib/items/links";
import type { AddLinkInput, LinkType } from "@/lib/items/links";
import { nextItemRevision } from "@/lib/services/item-revision";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, "select">;
type StoredLink = typeof itemLinks.$inferSelect;
type Endpoint = { id: string; key: string; backlogId: string };

export type LinkWithOther = {
  id: string;
  sourceId: string;
  targetId: string;
  type: LinkType;
  other: {
    id: string;
    key: string;
    title: string;
    type: typeof items.$inferSelect.type;
    statusId: string;
    statusName: string;
    statusColor: string;
    statusCategory: typeof statuses.$inferSelect.category;
  };
};

const owner = alias(items, "link_owner");

/** Both endpoints must be live and in the same backlog, including legacy links. */
async function readLinksForItem(itemId: string, reader: Reader = db) {
  async function direction(outgoing: boolean) {
    return reader.select({
      id: itemLinks.id, sourceId: itemLinks.sourceId, targetId: itemLinks.targetId,
      type: itemLinks.type, createdAt: itemLinks.createdAt, ownerKey: owner.key,
      other: {
        id: items.id, key: items.key, title: items.title, type: items.type,
        statusId: items.statusId, statusName: statuses.name, statusColor: statuses.color,
        statusCategory: statuses.category,
      },
    }).from(itemLinks)
      .innerJoin(owner, eq(owner.id, outgoing ? itemLinks.sourceId : itemLinks.targetId))
      .innerJoin(items, eq(items.id, outgoing ? itemLinks.targetId : itemLinks.sourceId))
      .innerJoin(statuses, and(eq(statuses.id, items.statusId), eq(statuses.backlogId, items.backlogId)))
      .where(and(eq(owner.id, itemId), eq(items.backlogId, owner.backlogId), isNull(owner.deletedAt), isNull(items.deletedAt)));
  }
  const [outgoing, incoming] = await Promise.all([direction(true), direction(false)]);
  return [...outgoing, ...incoming].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

export async function listLinksForItem(itemId: string): Promise<LinkWithOther[]> {
  return (await readLinksForItem(itemId)).map(({ createdAt, ownerKey, ...link }) => {
    void createdAt; void ownerKey;
    return link;
  });
}

export async function listDependenciesForItem(itemId: string, reader: Reader = db): Promise<Dependency[]> {
  return (await readLinksForItem(itemId, reader)).filter((link) => link.type === "blocks").map((link) => {
    const outgoing = link.sourceId === itemId;
    return {
      id: link.id,
      sourceKey: outgoing ? link.ownerKey : link.other.key,
      targetKey: outgoing ? link.other.key : link.ownerKey,
      direction: outgoing ? "blocks" : "blocked_by",
      other: { id: link.other.id, key: link.other.key, title: link.other.title,
        status: { id: link.other.statusId, name: link.other.statusName, category: link.other.statusCategory } },
    };
  });
}

/** A dependency id never grants access to unrelated, deleted or foreign items. */
export async function getDependencyLink(itemId: string, id: string) {
  return (await readLinksForItem(itemId)).find((link) => link.id === id && link.type === "blocks") ?? null;
}

async function liveEndpoint(tx: Reader, id: string): Promise<Endpoint> {
  const [item] = await tx.select({ id: items.id, key: items.key, backlogId: items.backlogId })
    .from(items).where(and(eq(items.id, id), isNull(items.deletedAt)));
  if (!item) throw new ResourceNotFoundError("item", id);
  return item;
}

/** Matches item creation/deletion: acquire the backlog lock before any item lock. */
async function lockLinkBacklog(tx: Tx, sourceId: string) {
  const probe = await liveEndpoint(tx, sourceId);
  const [backlog] = await tx.select({ id: backlogs.id }).from(backlogs)
    .where(eq(backlogs.id, probe.backlogId)).for("update");
  if (!backlog) throw new ResourceNotFoundError("item", sourceId);
  return backlog.id;
}

async function endpoints(tx: Reader, sourceId: string, targetId: string, backlogId: string) {
  const source = await liveEndpoint(tx, sourceId);
  const target = await liveEndpoint(tx, targetId);
  if (source.backlogId !== backlogId || target.backlogId !== backlogId) {
    throw new ResourceNotFoundError("item", targetId);
  }
  return { source, target };
}

async function logLinkChange(tx: Tx, link: StoredLink, source: Endpoint, target: Endpoint, actorId: string, added: boolean) {
  const requestCorrelationId = randomUUID();
  const meta = LINK_TYPE_META[link.type];
  const entries = [
    { itemId: source.id, value: `${meta.forward} ${target.key}` },
    { itemId: target.id, value: `${meta.inverse} ${source.key}` },
  ];
  await tx.update(items).set({ updatedAt: nextItemRevision() }).where(inArray(items.id, [source.id, target.id]));
  await tx.insert(activities).values(entries.map(({ itemId, value }) => ({
    itemId, actorId, action: "update" as const, field: "links",
    oldValue: added ? null : value, newValue: added ? value : null,
    ...activityAttribution(), requestCorrelationId,
  })));
}

async function insertLink(tx: Tx, data: AddLinkInput, actorId: string) {
  const backlogId = await lockLinkBacklog(tx, data.sourceId);
  const { source, target } = await endpoints(tx, data.sourceId, data.targetId, backlogId);
  const existing = await tx.select().from(itemLinks).where(or(
    and(eq(itemLinks.sourceId, source.id), eq(itemLinks.targetId, target.id)),
    and(eq(itemLinks.sourceId, target.id), eq(itemLinks.targetId, source.id)),
  ));
  if (isDuplicateLink(existing, source.id, target.id, data.type)) throw new Error("Ce lien existe déjà.");
  if (data.type === "blocks") {
    // Keep deleted intermediate items: restoring one must not reveal a new cycle.
    // UNION (not UNION ALL) terminates even when a legacy graph contains cycles.
    // Under READ COMMITTED, this runs after the backlog lock sees prior commits.
    const path = await tx.execute(sql`
      with recursive reachable(id) as (
        select id from items where id = ${target.id}::uuid
          and backlog_id = ${backlogId}::uuid
        union
        select neighbour.id from reachable
          join item_links edge on edge.source_id = reachable.id and edge.type = 'blocks'
          join items neighbour on neighbour.id = edge.target_id
            and neighbour.backlog_id = ${backlogId}::uuid
      )
      select id from reachable where id = ${source.id}::uuid limit 1
    `);
    if (path.rows.length) throw new Error("Cycle : cette dépendance créerait un blocage circulaire.");
  }
  const [link] = await tx.insert(itemLinks).values({ ...data, createdBy: actorId }).returning();
  await logLinkChange(tx, link!, source, target, actorId, true);
  return link!;
}

/** Shared by the screen, REST, MCP and scripts; all blocking cycles are refused. */
export async function addLink(input: unknown, actorId: string): Promise<StoredLink> {
  const data = addLinkInput.parse(input);
  return db.transaction((tx) => insertLink(tx, data, actorId));
}

export async function addDependency(input: unknown, itemId: string, actorId: string) {
  const data = addLinkInput.parse(input);
  if (data.type !== "blocks" || ![data.sourceId, data.targetId].includes(itemId)) throw new ResourceNotFoundError("item", itemId);
  return db.transaction(async (tx) => {
    const link = await insertLink(tx, data, actorId);
    // Return a snapshot from the same transaction, even if another writer removes it later.
    const dependency = (await listDependenciesForItem(itemId, tx)).find((entry) => entry.id === link.id);
    if (!dependency) throw new Error("Inconsistent dependency after insertion.");
    return { dependency };
  });
}

async function deleteLink(id: string, actorId: string, itemId?: string) {
  return db.transaction(async (tx) => {
    const [probe] = await tx.select().from(itemLinks).where(eq(itemLinks.id, id));
    const valid = (link: StoredLink | undefined) => link && (itemId === undefined ||
      (link.type === "blocks" && [link.sourceId, link.targetId].includes(itemId)));
    if (!valid(probe)) {
      if (itemId !== undefined) throw new ResourceNotFoundError("link", id);
      return undefined;
    }
    const backlogId = await lockLinkBacklog(tx, probe!.sourceId);
    const [link] = await tx.select().from(itemLinks).where(eq(itemLinks.id, id));
    if (!valid(link)) {
      if (itemId !== undefined) throw new ResourceNotFoundError("link", id);
      return undefined;
    }
    const { source, target } = await endpoints(tx, link!.sourceId, link!.targetId, backlogId);
    const [removed] = await tx.delete(itemLinks).where(eq(itemLinks.id, id)).returning();
    if (removed) await logLinkChange(tx, removed, source, target, actorId, false);
    return removed;
  });
}

/** UI compatibility: already removed links remain a no-op. */
export function removeLink(id: string, actorId: string) {
  return deleteLink(id, actorId);
}

export async function removeDependency(input: { itemId: string; id: string }, actorId: string) {
  const removed = await deleteLink(input.id, actorId, input.itemId);
  if (!removed) throw new ResourceNotFoundError("link", input.id);
  return removed;
}

/**
 * Returns the distinct targetIds of `blocks` links in `backlogId` where the
 * source (blocker) item is live and NOT in a "done" status category.
 * Used by the UI to render "bloqué" badges.
 */
export async function blockedItemIds(backlogId: string): Promise<string[]> {
  // Join itemLinks (blocks) → source items → source statuses.
  // Filter: source in backlog, source not deleted, source status category != 'done'.
  // Return distinct targetIds.
  const rows = await db
    .selectDistinct({ targetId: itemLinks.targetId })
    .from(itemLinks)
    .innerJoin(items, eq(items.id, itemLinks.sourceId))
    .innerJoin(statuses, eq(statuses.id, items.statusId))
    .where(
      and(
        eq(itemLinks.type, "blocks"),
        eq(items.backlogId, backlogId),
        isNull(items.deletedAt),
        ne(statuses.category, "done"),
      ),
    );

  return rows.map((r) => r.targetId);
}
