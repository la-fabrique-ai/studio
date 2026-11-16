import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { activityAttribution } from "@/lib/auth/actor-context";
import { ResourceNotFoundError } from "@/lib/auth/authorization";
import { db } from "@/lib/db";
import { activities, backlogs, itemLabels, items, labels } from "@/lib/db/schema/domain";
import { LABEL_COLOR_VAR } from "@/lib/design/constants";
import { createLabelInput, labelColorVarForName, normalizeLabelName } from "@/lib/items/labels";
import { nextItemRevision } from "@/lib/services/item-revision";

/** Reuses a global name before a local one; concurrent local creates share one row. */
export async function createLabelWithResult(input: unknown) {
  const parsed = createLabelInput.parse(input);
  const name = normalizeLabelName(parsed.name);
  return db.transaction(async (tx) => {
    const [backlog] = await tx.select({ id: backlogs.id }).from(backlogs)
      .where(eq(backlogs.id, parsed.backlogId)).for("update");
    if (!backlog) throw new ResourceNotFoundError("backlog", parsed.backlogId);
    const findExisting = async () => {
      const [row] = await tx.select().from(labels).where(and(
        or(eq(labels.backlogId, parsed.backlogId), isNull(labels.backlogId)),
        sql`lower(${labels.name}) = lower(${name})`,
      )).orderBy(sql`${labels.backlogId} nulls first`, asc(labels.id)).limit(1);
      return row;
    };
    const existing = await findExisting();
    if (existing) return { label: existing, created: false };
    const [inserted] = await tx.insert(labels).values({
      name, backlogId: parsed.backlogId, color: LABEL_COLOR_VAR[labelColorVarForName(name)],
    }).onConflictDoNothing().returning();
    if (inserted) return { label: inserted, created: true };
    // A writer outside this service may have won the unique index race.
    // This new statement sees its committed row under READ COMMITTED.
    const winner = await findExisting();
    if (!winner) throw new Error("Concurrent label creation returned no label.");
    return { label: winner, created: false };
  });
}

/** UI compatibility: the catalogue action historically returns the label alone. */
export async function createLabel(input: unknown) {
  return (await createLabelWithResult(input)).label;
}

const deltaInput = z.object({
  itemId: z.uuid(), backlogId: z.uuid(), labelId: z.uuid(), present: z.boolean(),
}).strict();

/** Applies a delta under the same item lock as updateItem's label replacement. */
export async function setItemLabel(input: unknown, actorId: string, requestCorrelationId = randomUUID()) {
  const data = deltaInput.parse(input);
  return db.transaction(async (tx) => {
    const [item] = await tx.select({ id: items.id }).from(items).where(and(
      eq(items.id, data.itemId), eq(items.backlogId, data.backlogId), isNull(items.deletedAt),
    )).for("update");
    if (!item) throw new ResourceNotFoundError("item", data.itemId);
    const [label] = await tx.select({ id: labels.id }).from(labels).where(and(
      eq(labels.id, data.labelId), or(eq(labels.backlogId, data.backlogId), isNull(labels.backlogId)),
    )).limit(1);
    if (!label) throw new ResourceNotFoundError("label", data.labelId);
    const rows = await tx.select({ labelId: itemLabels.labelId }).from(itemLabels).where(eq(itemLabels.itemId, item.id));
    const current = new Set(rows.map((row) => row.labelId));
    if (current.has(label.id) === data.present) return { changed: false };
    const oldValue = [...current].sort().join(",") || null;
    if (data.present) {
      await tx.insert(itemLabels).values({ itemId: item.id, labelId: label.id });
      current.add(label.id);
    } else {
      await tx.delete(itemLabels).where(and(eq(itemLabels.itemId, item.id), eq(itemLabels.labelId, label.id)));
      current.delete(label.id);
    }
    await tx.update(items).set({ updatedAt: nextItemRevision() }).where(eq(items.id, item.id));
    await tx.insert(activities).values({
      itemId: item.id, actorId, action: "update", field: "labels", oldValue,
      newValue: [...current].sort().join(",") || null,
      ...activityAttribution(), requestCorrelationId,
    });
    return { changed: true };
  });
}
