import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, describe, vi } from "vitest";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema/auth";
import { activities, items, itemLinks, permissionGrants, securityAuditEvents, statuses } from "@/lib/db/schema/domain";
import { createApiToken, type ApiPrincipal } from "@/lib/services/api-tokens";
import { addLink, listLinksForItem } from "@/lib/services/links";
import { createReadVisibilityFixture, deleteReadVisibilityFixture, type ReadVisibilityFixture } from "@/lib/services/read-visibility.integration-fixture";
import { GET, POST } from "@/app/api/v1/items/[key]/dependencies/route";
import { DELETE } from "@/app/api/v1/items/[key]/dependencies/[id]/route";
import { GET as detail } from "@/app/api/v1/items/[key]/route";
import { JIROO_TOOLS, runTool } from "@/lib/mcp/tools";
vi.mock("server-only", () => ({}));
const actionSession = vi.hoisted(() => ({ actorId: "" }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => ({ user: { id: actionSession.actorId } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { addLinkAction } from "@/app/actions/links";
const describeDb = process.env.JIROO_RUN_DB_TESTS === "1" ? describe : describe.skip;
describeDb("blocking dependencies across REST and MCP", () => {
  let f: ReadVisibilityFixture;
  let token: string; let readToken: string;
  let writer: ApiPrincipal; let reader: ApiPrincipal;
  let neighbour: typeof items.$inferSelect; let third: typeof items.$inferSelect;
  const context = (key: string, id: string = randomUUID()) => ({ params: Promise.resolve({ key, id }) });
  const request = (method = "GET", body?: unknown, bearer = token) => new Request("http://localhost/api/v1", { method, headers: { authorization: `Bearer ${bearer}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const tool = (name: string, input: unknown, principal = writer) => runTool(JIROO_TOOLS.find((t) => t.name === name)!, input, principal);
  beforeAll(async () => {
    f = await createReadVisibilityFixture("API dependencies");
    actionSession.actorId = f.actorA;
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, f.actorA));
    for (const scope of ["write", "read"] as const) {
      const issued = await createApiToken({ name: `Deps ${scope}`, scope, expiresInDays: 30 }, f.actorA, { authVersion: 0 });
      const principal = { actorId: f.actorA, tokenId: issued.row.id, scope };
      if (scope === "write") { token = issued.token; writer = principal; } else { readToken = issued.token; reader = principal; }
    }
    for (const [item, number] of [[f.liveA, 1], [f.liveB, 1], [f.trashA, 4]] as const) {
      item.key = `${item.backlogId === f.backlogA.id ? f.backlogA.key : f.backlogB.key}-${number}`;
      await db.update(items).set({ key: item.key }).where(eq(items.id, item.id));
    }
    const inserted = await db.insert(items).values([2, 3].map((n) => {
      const id = randomUUID();
      return { id, key: `${f.backlogA.key}-${n}`, type: "tache" as const, backlogId: f.backlogA.id, title: `Neighbour ${n}`, reporterId: f.actorA, statusId: f.liveA.statusId, path: `root.${id.replaceAll("-", "")}`, rank: `a${n}` };
    })).returning();
    [neighbour, third] = [inserted[0]!, inserted[1]!];
  });
  afterAll(async () => {
    if (f) { await db.delete(securityAuditEvents).where(inArray(securityAuditEvents.actorId, f.userIds)); await deleteReadVisibilityFixture(f); }
  });
  it("requires link_items and refuses read tokens on both mutation transports", async () => {
    const input = { otherKey: neighbour.key, direction: "blocks" };
    expect((await POST(request("POST", input), context(f.liveA.key))).status).toBe(403);
    expect((await tool("add_dependency", { key: f.liveA.key, ...input })).isError).toBe(true);
    for (const handler of [POST, DELETE]) expect((await handler(request("POST", input, readToken), context(f.liveA.key))).status).toBe(403);
    for (const name of ["add_dependency", "remove_dependency"]) expect((await tool(name, { key: f.liveA.key, ...input, id: randomUUID() }, reader)).isError).toBe(true);
    expect((await GET(request(), context(f.liveA.key))).status).toBe(200);
    await db.insert(permissionGrants).values({ scope: "backlog", permissionSchemeId: f.schemeIds[0], permissionKey: "link_items", principalType: "user", userId: f.actorA });
  });
  it("masks unknown, deleted, foreign and unreadable endpoints, and validates self links", async () => {
    const responses = [];
    for (const otherKey of [`${f.backlogA.key}-999`, f.trashA.key, f.liveB.key]) {
      const response = await POST(request("POST", { otherKey, direction: "blocks" }), context(f.liveA.key));
      expect(response.status).toBe(404); responses.push(await response.json());
    }
    expect(responses[0]).toEqual(responses[1]); expect(responses[1]).toEqual(responses[2]);
    expect((await POST(request("POST", { otherKey: f.liveA.key, direction: "blocks" }), context(f.liveA.key))).status).toBe(400);
    // A browsable second backlog must still stay foreign to this item.
    await db.insert(permissionGrants).values({ scope: "backlog", permissionSchemeId: f.schemeIds[1], permissionKey: "browse_backlog", principalType: "user", userId: f.actorA });
    const foreign = await POST(request("POST", { otherKey: f.liveB.key, direction: "blocks" }), context(f.liveA.key));
    expect(foreign.status).toBe(404); expect(await foreign.json()).toEqual(responses[0]);
    const hidden = await GET(request(), context(`${f.backlogB.key}-999`));
    const absent = await GET(request(), context(`${f.backlogA.key}-999`)); expect(hidden.status).toBe(404); expect(await hidden.json()).toEqual(await absent.json());
  });
  it("orients blocked_by, exposes neighbour status in lists and details, logs both ends, and removes across transports", async () => {
    const response = await POST(request("POST", { otherKey: neighbour.key, direction: "blocked_by" }), context(f.liveA.key));
    expect(response.status).toBe(201); const { dependency } = await response.json();
    expect(dependency).toMatchObject({ sourceKey: neighbour.key, targetKey: f.liveA.key, direction: "blocked_by", other: { key: neighbour.key, status: { id: neighbour.statusId, category: "todo" } } });
    const [done] = await db.insert(statuses).values({ backlogId: f.backlogA.id, name: "Done", category: "done", order: 1, color: "#00aa00" }).returning();
    await db.update(items).set({ statusId: done!.id }).where(eq(items.id, neighbour.id));
    const rest = (await (await GET(request(), context(f.liveA.key))).json()).dependencies;
    expect(rest[0].other.status).toEqual({ id: done!.id, name: "Done", category: "done" });
    expect((await tool("list_dependencies", { key: f.liveA.key }, reader)).structuredContent).toEqual({ dependencies: rest });
    expect((await (await detail(request(), context(f.liveA.key))).json()).item.dependencies).toEqual(rest);
    expect((await tool("get_item", { key: f.liveA.key }, reader)).structuredContent!.item).toMatchObject({ dependencies: rest });
    // Same logical relation via its other endpoint and opposite direction.
    expect((await tool("add_dependency", { key: neighbour.key, otherKey: f.liveA.key, direction: "blocks" })).isError).toBe(true);
    expect((await POST(request("POST", { otherKey: neighbour.key, direction: "blocked_by" }), context(f.liveA.key))).status).toBe(409);
    const before = await db.select().from(activities).where(eq(activities.field, "links"));
    const ours = before.filter((a) => [f.liveA.id, neighbour.id].includes(a.itemId));
    expect(ours).toHaveLength(2); expect(ours.every((a) => a.source === "api" && a.tokenId === writer.tokenId)).toBe(true);
    expect(new Set(ours.map((a) => a.requestCorrelationId)).size).toBe(1);
    expect((await tool("remove_dependency", { key: third.key, id: dependency.id })).isError).toBe(true);
    expect((await tool("remove_dependency", { key: f.liveA.key, id: dependency.id })).structuredContent).toEqual({ removed: true });
    expect((await DELETE(request("DELETE"), context(f.liveA.key, dependency.id))).status).toBe(404);
    const after = await db.select().from(activities).where(and(eq(activities.field, "links"), inArray(activities.itemId, [f.liveA.id, neighbour.id])));
    expect(after).toHaveLength(4); expect(after.filter((a) => a.source === "mcp" && a.newValue === null)).toHaveLength(2);
  });
  it("refuses direct and long cycles through the common service, including a pre-existing cycle", async () => {
    const first = await addLink({ sourceId: f.liveA.id, targetId: neighbour.id, type: "blocks" }, f.actorA);
    await expect(addLink({ sourceId: neighbour.id, targetId: f.liveA.id, type: "blocks" }, f.actorA)).rejects.toThrow("cycle de blocage");
    await addLink({ sourceId: neighbour.id, targetId: third.id, type: "blocks" }, f.actorA);
    const long = await POST(request("POST", { otherKey: f.liveA.key, direction: "blocks" }), context(third.key)); expect(long.status).toBe(409);
    const screen = await addLinkAction({ backlogKey: f.backlogA.key, sourceId: third.id, targetId: f.liveA.id, type: "blocks" });
    expect(screen).toMatchObject({ ok: false, error: expect.stringContaining("cycle de blocage") });
    // Legacy graph cycles must terminate UNION traversal rather than looping.
    await db.insert(itemLinks).values({ sourceId: third.id, targetId: neighbour.id, type: "blocks" });
    await expect(addLink({ sourceId: third.id, targetId: f.liveA.id, type: "blocks" }, f.actorA)).rejects.toThrow("cycle de blocage");
    expect((await DELETE(request("DELETE"), context(f.liveA.key, first.id))).status).toBe(204);
  });
  it("also refuses a cycle whose existing path crosses a deleted item", async () => {
    const path = await db.insert(itemLinks).values([
      { sourceId: f.liveA.id, targetId: f.trashA.id, type: "blocks" },
      { sourceId: f.trashA.id, targetId: third.id, type: "blocks" },
    ]).returning();
    try {
      await expect(addLink({ sourceId: third.id, targetId: f.liveA.id, type: "blocks" }, f.actorA)).rejects.toThrow("cycle de blocage");
    } finally { await db.delete(itemLinks).where(inArray(itemLinks.id, path.map((link) => link.id))); }
  });
  it("hides relates and historical cross-backlog/deleted links from dependency reads and deletes", async () => {
    const relates = await addLink({ sourceId: f.liveA.id, targetId: third.id, type: "relates" }, f.actorA);
    expect((await DELETE(request("DELETE"), context(f.liveA.key, relates.id))).status).toBe(404);
    expect((await tool("remove_dependency", { key: f.liveA.key, id: relates.id })).isError).toBe(true);
    const bad = await db.insert(itemLinks).values([
      { sourceId: f.liveA.id, targetId: f.liveB.id, type: "blocks" },
      { sourceId: f.liveA.id, targetId: f.trashA.id, type: "blocks" },
    ]).returning();
    expect((await (await GET(request(), context(f.liveA.key))).json()).dependencies).toEqual([]);
    expect((await listLinksForItem(f.liveA.id)).map((l) => l.id)).toEqual([relates.id]);
    for (const link of bad) expect((await DELETE(request("DELETE"), context(f.liveA.key, link.id))).status).toBe(404);
  });
});
