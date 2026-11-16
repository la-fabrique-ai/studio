import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const m = vi.hoisted(() => ({ transaction: vi.fn(), select: vi.fn(), execute: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: m }));
import { addLink } from "@/lib/services/links";
import { runWithActor } from "@/lib/auth/actor-context";
import { activities, backlogs, items, itemLinks } from "@/lib/db/schema/domain";
const sourceId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const backlogId = "33333333-3333-4333-8333-333333333333";
const source = { id: sourceId, backlogId, key: "TEST-1", deletedAt: null };
const target = { id: targetId, backlogId, key: "TEST-2", deletedAt: null };
let insertedActivities: unknown;
beforeEach(() => {
  vi.resetAllMocks(); insertedActivities = undefined;
  m.transaction.mockImplementation(async (work) => work(m));
  m.select.mockImplementation(() => {
    let value: unknown[] = [];
    let table: unknown;
    const query = {
      from: (selected: unknown) => { table = selected; return query; },
      where: (condition: import("drizzle-orm").SQL) => {
        const params = new PgDialect().sqlToQuery(condition).params;
        value = table === backlogs ? [{ id: backlogId }] : table === items ? [params.includes(targetId) ? target : source] : [];
        return query;
      },
      limit: () => query,
      for: () => Promise.resolve(value),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve),
    };
    return query;
  });
  m.execute.mockResolvedValue({ rows: [] });
  m.insert.mockImplementation((table) => ({ values: (values: unknown) => {
    if (table === activities) { insertedActivities = values; return Promise.resolve(); }
    return { returning: async () => [{ id: "link", sourceId, targetId, type: "blocks" }] };
  } }));
  m.update.mockReturnValue({ set: () => ({ where: async () => [] }) });
});
it("rejects an indirect blocks cycle before inserting or logging", async () => {
  m.execute.mockResolvedValueOnce({ rows: [{ id: sourceId }] });
  await expect(addLink({ sourceId, targetId, type: "blocks" }, "actor")).rejects.toThrow("Cycle");
  expect(m.insert).not.toHaveBeenCalled();
});
it("records both endpoints with source/token attribution in the mutation transaction", async () => {
  await runWithActor({ actorId: "actor", source: "api", tokenId: "token" }, () => addLink({ sourceId, targetId, type: "blocks" }, "actor"));
  expect(m.insert).toHaveBeenCalledWith(itemLinks);
  expect(insertedActivities).toEqual([
    expect.objectContaining({ itemId: sourceId, actorId: "actor", action: "update", field: "links", oldValue: null, newValue: "Bloque TEST-2", source: "api", tokenId: "token", requestCorrelationId: expect.any(String) }),
    expect.objectContaining({ itemId: targetId, actorId: "actor", action: "update", field: "links", oldValue: null, newValue: "Est bloqué par TEST-1", source: "api", tokenId: "token", requestCorrelationId: expect.any(String) }),
  ]);
  const entries = insertedActivities as { requestCorrelationId: string }[];
  expect(entries[0]!.requestCorrelationId).toBe(entries[1]!.requestCorrelationId);
});
it("checks the path target to source using recursive set traversal", async () => {
  await addLink({ sourceId, targetId, type: "blocks" }, "actor");
  const query = new PgDialect().sqlToQuery(m.execute.mock.calls[0]![0]);
  expect(query.sql).toMatch(/with recursive/i); expect(query.sql).toMatch(/union(?! all)/i);
  expect(query.params).toContain(targetId); expect(query.params).toContain(sourceId); expect(query.params).toContain(backlogId);
});
it("skips cycle traversal for non-blocking links", async () => {
  await addLink({ sourceId, targetId, type: "relates" }, "actor"); expect(m.execute).not.toHaveBeenCalled();
});
