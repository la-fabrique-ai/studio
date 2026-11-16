import { expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schema/domain";
it("keeps creation keys per actor and backlog, retaining tombstones when items are purged", () => {
  expect(schema).toHaveProperty("itemCreationRequests");
  const table = getTableConfig(schema.itemCreationRequests);
  expect(table.columns.map((c) => c.name)).toEqual(["actor_id", "backlog_id", "key", "request_hash", "item_id", "item_key", "created_at"]);
  expect(table.primaryKeys[0]?.columns.map((c) => c.name)).toEqual(["actor_id", "backlog_id", "key"]);
  expect(table.foreignKeys.map((fk) => [fk.reference().columns[0]?.name, fk.onDelete])).toEqual(expect.arrayContaining([["actor_id", "cascade"], ["backlog_id", "cascade"], ["item_id", "set null"]]));
  expect(table.indexes.some((idx) => idx.config.columns.some((col) => "name" in col && col.name === "item_id"))).toBe(true);
});
