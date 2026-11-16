import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    transaction: async (run: (tx: object) => unknown) => run({
      select: () => {
        const rows = m.rows.shift();
        const query = {
          from: () => query,
          where: () => query,
          for: async () => rows,
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
        };
        return query;
      },
    }),
  },
}));
import { updateItem } from "@/lib/services/items";
import { ResourceNotFoundError } from "@/lib/auth/authorization";
const id = "11111111-1111-4111-8111-111111111111";
const labelId = "abcdef12-abcd-4abc-8abc-abcdef123456";
beforeEach(() => { m.rows = [[{ id, backlogId: "backlog-1", type: "composant" }], []]; });
describe("replacement label validation", () => {
  it("uses ResourceNotFoundError when a replacement label is not available in the backlog", async () => {
    await expect(updateItem({ id, labelIds: [labelId] }, "u")).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
