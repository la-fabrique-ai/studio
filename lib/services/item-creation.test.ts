import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ openTransactions: 0, previous: [] as unknown[], current: [] as unknown[], tables: [] as string[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { transaction: async (work: (tx: unknown) => Promise<unknown>) => {
  state.openTransactions++;
  const tx = { select: () => ({ from: (table: { [key: symbol]: unknown }) => {
    const name = table[Symbol.for("drizzle:Name")] as string; state.tables.push(name);
    const rows = name === "backlogs" ? [{ id: "b", key: "TEST" }] : name === "item_creation_requests" ? state.previous : state.current;
    const query = { where: () => query, for: () => query, then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve) };
    return query;
  } }) };
  try { return await work(tx); } finally { state.openTransactions--; }
} } }));
import { createItemWithRequest } from "./items";
const request = { backlogId: "b", key: "key", requestHash: "hash" };
beforeEach(() => { state.previous = []; state.current = []; state.tables = []; state.openTransactions = 0; });
it("prepares permissions outside the locked transaction, avoiding audit FK waits and pool starvation", async () => {
  const prepare = vi.fn(async () => {
    expect(state.openTransactions).toBe(0);
    throw new Error("stop before creation");
  });
  await expect(createItemWithRequest(request, "u", prepare, vi.fn())).rejects.toThrow("stop before creation");
  expect(prepare).toHaveBeenCalledTimes(1);
});
it("reads the reservation after locking the backlog and authorizes the replay outside the transaction", async () => {
  state.previous = [{ requestHash: "hash", itemId: "i" }]; state.current = [{ id: "i", backlogId: "b", deletedAt: null }];
  const prepare = vi.fn(); const authorize = vi.fn(async () => { expect(state.openTransactions).toBe(0); });
  expect(await createItemWithRequest(request, "u", prepare, authorize)).toMatchObject({ replayed: true, item: { id: "i" } });
  expect(state.tables).toEqual(["backlogs", "item_creation_requests", "items"]); expect(prepare).not.toHaveBeenCalled(); expect(authorize).toHaveBeenCalledTimes(1);
});
it.each([
  [{ requestHash: "different", itemId: "i" }, [], "contenu différent"],
  [{ requestHash: "hash", itemId: null }, [], "supprimé"],
  [{ requestHash: "hash", itemId: "i" }, [{ id: "i", deletedAt: new Date() }], "supprimé"],
] as const)("refuses a conflicting or deleted reservation without resolving creation references", async (previous, current, message) => {
  state.previous = [previous]; state.current = [...current]; const prepare = vi.fn();
  await expect(createItemWithRequest(request, "u", prepare, vi.fn())).rejects.toThrow(message);
  expect(prepare).not.toHaveBeenCalled();
});
