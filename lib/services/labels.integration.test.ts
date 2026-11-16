import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema/auth";
import { activities, apiTokens, backlogs, itemLabels, items, labels, statuses } from "@/lib/db/schema/domain";
import { runWithActor } from "@/lib/auth/actor-context";
import { createItem } from "@/lib/services/items";
import { createLabelWithResult, setItemLabel } from "@/lib/services/labels";
const describeDb = process.env.STUDIO_RUN_DB_TESTS === "1" ? describe : describe.skip;
describeDb("label transactions", () => {
  const actorId = `labels-${randomUUID()}`;
  const backlogId = randomUUID(); const foreignBacklogId = randomUUID(); const itemId = randomUUID(); const tokenId = randomUUID();
  const globalIds: string[] = [];
  let statusId: string; let key: string; let localId: string; let globalId: string; let foreignId: string;
  const actor = { actorId, source: "mcp" as const, tokenId };
  const delta = (labelId: string, present: boolean, targetItemId = itemId) => runWithActor(actor, () => setItemLabel({ itemId: targetItemId, backlogId, labelId, present }, actorId));
  const memberships = async () => (await db.select().from(itemLabels).where(eq(itemLabels.itemId, itemId))).map((row) => row.labelId).sort();
  const journal = () => db.select().from(activities).where(and(eq(activities.itemId, itemId), eq(activities.field, "labels")));
  beforeAll(async () => {
    await db.insert(user).values({ id: actorId, name: "Labels test", email: `${randomUUID()}@labels.test`, emailVerified: true });
    await db.insert(apiTokens).values({ id: tokenId, userId: actorId, name: "Labels test", tokenHash: randomUUID(), tokenPrefix: "test", scope: "write" });
    key = `L${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`;
    await db.insert(backlogs).values([{ id: backlogId, key, name: "Labels", color: "#475569" }, { id: foreignBacklogId, key: `F${randomUUID().replaceAll("-", "").slice(0, 7)}`, name: "Foreign labels", color: "#475569" }]);
    const [status] = await db.insert(statuses).values({ backlogId, name: "Todo", category: "todo", order: 0, color: "#475569" }).returning(); statusId = status!.id;
    await db.insert(items).values({ id: itemId, backlogId, key: `${key}-1`, title: "Labels", type: "composant", statusId, reporterId: actorId, rank: "a0", path: `root.${itemId.replaceAll("-", "")}`, depth: 0 });
    const inserted = await db.insert(labels).values([{ backlogId, name: "Local", color: "--label-1" }, { backlogId: null, name: `Global ${randomUUID()}`, color: "--label-2" }, { backlogId: foreignBacklogId, name: "Foreign", color: "--label-3" }]).returning();
    [localId, globalId, foreignId] = inserted.map((label) => label.id) as [string, string, string]; globalIds.push(globalId);
  });
  afterAll(async () => {
    await db.delete(backlogs).where(inArray(backlogs.id, [backlogId, foreignBacklogId]));
    if (globalIds.length) await db.delete(labels).where(inArray(labels.id, globalIds));
    await db.delete(user).where(eq(user.id, actorId));
  });
  it("creates one normalized local label for concurrent calls, including the UI service", async () => {
    const { createLabel } = await import("@/lib/services/labels");
    const name = ` Concurrent ${randomUUID()} `;
    const [a, b, ui] = await Promise.all([
      createLabelWithResult({ backlogId, name }), createLabelWithResult({ backlogId, name: name.trim().toUpperCase() }), createLabel({ backlogId, name }),
    ]);
    expect(a.label.id).toBe(b.label.id); expect(ui.id).toBe(a.label.id);
    const rows = await db.select().from(labels).where(and(eq(labels.backlogId, backlogId), eq(labels.id, a.label.id)));
    expect(rows).toHaveLength(1); expect(rows[0]?.name).toBe(rows[0]?.name.trim());
    expect((await db.select().from(activities).where(eq(activities.itemId, itemId)))).toEqual([]);
  });
  it("reuses an existing global label without creating a local one", async () => {
    const [global] = await db.select().from(labels).where(eq(labels.id, globalId));
    expect(await createLabelWithResult({ backlogId, name: global!.name.toUpperCase() })).toEqual({ label: global, created: false });
  });
  it("adds/removes a global label, logs source and token once per change, and skips no-ops", async () => {
    const before = await journal();
    expect(await delta(globalId, false)).toEqual({ changed: false });
    expect(await delta(globalId, true)).toEqual({ changed: true });
    expect(await delta(globalId, true)).toEqual({ changed: false });
    expect(await memberships()).toContain(globalId);
    expect(await delta(globalId, false)).toEqual({ changed: true });
    expect(await delta(globalId, false)).toEqual({ changed: false });
    expect(await memberships()).not.toContain(globalId);
    const rows = (await journal()).slice(before.length);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId, source: "mcp", tokenId, action: "update", field: "labels", oldValue: null, newValue: globalId }),
      expect.objectContaining({ actorId, source: "mcp", tokenId, action: "update", field: "labels", oldValue: globalId, newValue: null }),
    ]));
  });
  it("rejects foreign or unknown labels for both deltas with no journal or membership change", async () => {
    const before = await journal(); const current = await memberships();
    for (const id of [foreignId, randomUUID()]) for (const present of [true, false]) {
      await expect(delta(id, present)).rejects.toMatchObject({ name: "ResourceNotFoundError" });
    }
    expect(await journal()).toEqual(before); expect(await memberships()).toEqual(current);
  });
  it("serializes deltas without losing another label, including duplicate concurrent operations", async () => {
    const results = await Promise.all([delta(localId, true), delta(globalId, true), delta(localId, true)]);
    expect(results.filter((result) => result.changed)).toHaveLength(2);
    expect(await memberships()).toEqual([localId, globalId].sort());
    await Promise.all([delta(localId, false), delta(globalId, false)]); expect(await memberships()).toEqual([]);
  });
  it("deduplicates initial labels, and rolls back unknown or foreign initial labels", async () => {
    const created = await runWithActor(actor, () => createItem({ backlogId, type: "composant", title: "Initial labels", labelIds: [localId, localId, globalId] }, actorId));
    expect(await db.select({ labelId: itemLabels.labelId }).from(itemLabels).where(eq(itemLabels.itemId, created.id))).toHaveLength(2);
    for (const labelId of [foreignId, randomUUID()]) {
      await expect(createItem({ backlogId, type: "composant", title: "Rejected labels", labelIds: [labelId] }, actorId)).rejects.toMatchObject({ name: "ResourceNotFoundError" });
    }
    expect(await db.select().from(items).where(and(eq(items.backlogId, backlogId), eq(items.title, "Rejected labels")))).toEqual([]);
  });
  it("hides a deleted item and rejects a stale authorized backlog", async () => {
    await expect(runWithActor(actor, () => setItemLabel({ itemId, backlogId: foreignBacklogId, labelId: foreignId, present: true }, actorId))).rejects.toMatchObject({ name: "ResourceNotFoundError" });
    await db.update(items).set({ deletedAt: new Date() }).where(eq(items.id, itemId));
    try { await expect(delta(localId, true)).rejects.toMatchObject({ name: "ResourceNotFoundError" }); }
    finally { await db.update(items).set({ deletedAt: null }).where(eq(items.id, itemId)); }
  });
});
