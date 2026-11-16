import { describe, expect, it } from "vitest";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { labels } from "@/lib/db/schema/domain";

describe("label name uniqueness", () => {
  it("enforces case-insensitive names within a backlog without adding a column", () => {
    const config = getTableConfig(labels);
    const index = config.indexes.find((entry) => entry.config.name === "labels_backlog_name_idx");
    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns[0]).toMatchObject({ name: "backlog_id" });
    expect(new PgDialect().sqlToQuery(index!.config.columns[1] as import("drizzle-orm").SQL).sql).toBe('lower("labels"."name")');
    expect(config.columns.map((column) => column.name)).toEqual(["id", "backlog_id", "name", "color"]);
  });
});
