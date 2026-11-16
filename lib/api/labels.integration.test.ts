import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/realtime/publish", () => ({ publishBacklogChange: vi.fn(), notifyUsers: vi.fn() }));
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema/auth";
import { activities, itemLabels, items, labels, permissionGrants, securityAuditEvents } from "@/lib/db/schema/domain";
import { createApiToken, type ApiPrincipal } from "@/lib/services/api-tokens";
import { createReadVisibilityFixture, deleteReadVisibilityFixture, type ReadVisibilityFixture } from "@/lib/services/read-visibility.integration-fixture";
import { GET as list, POST as createLabel } from "@/app/api/v1/backlogs/[key]/labels/route";
import { PUT as add, DELETE as remove } from "@/app/api/v1/items/[key]/labels/[labelId]/route";
import { POST as createItem } from "@/app/api/v1/items/route";
import { GET as detail } from "@/app/api/v1/items/[key]/route";
import { STUDIO_TOOLS, runTool } from "@/lib/mcp/tools";

const describeDb = process.env.JIROO_RUN_DB_TESTS === "1" ? describe : describe.skip;
describeDb("labels across REST and MCP with real permissions", () => {
  let fixture: ReadVisibilityFixture;
  let token: string; let readToken: string; let outsiderToken: string;
  let writer: ApiPrincipal; let reader: ApiPrincipal; let outsider: ApiPrincipal;
  let global: typeof labels.$inferSelect; let foreignId: string; let localId: string;
  const request = (method = "GET", body?: unknown, bearer = token) => new Request("http://localhost/api/v1", { method, headers: { authorization: `Bearer ${bearer}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const context = (key: string, labelId?: string) => ({ params: Promise.resolve({ key, labelId: labelId! }) });
  const tool = (name: string, input: unknown, principal = writer) => runTool(STUDIO_TOOLS.find((entry) => entry.name === name)!, input, principal);
  beforeAll(async () => {
    fixture = await createReadVisibilityFixture("API labels");
    await db.update(user).set({ twoFactorEnabled: true }).where(inArray(user.id, [fixture.actorA, fixture.actorB]));
    fixture.liveA.key = `${fixture.backlogA.key}-1`;
    await db.update(items).set({ key: fixture.liveA.key }).where(eq(items.id, fixture.liveA.id));
    for (const [scope, actorId] of [["write", fixture.actorA], ["read", fixture.actorA], ["write", fixture.actorB]] as const) {
      const issued = await createApiToken({ name: `Labels ${scope}`, scope, expiresInDays: 30 }, actorId, { authVersion: 0 });
      const principal = { actorId, tokenId: issued.row.id, scope };
      if (actorId === fixture.actorB) { outsiderToken = issued.token; outsider = principal; }
      else if (scope === "write") { token = issued.token; writer = principal; }
      else { readToken = issued.token; reader = principal; }
    }
    // actorA starts with browse + create, but no edit_items.
    await db.insert(permissionGrants).values({ scope: "backlog", permissionSchemeId: fixture.schemeIds[0], permissionKey: "create_items", principalType: "user", userId: fixture.actorA });
    const inserted = await db.insert(labels).values([
      { name: `Global ${randomUUID()}`, color: "--label-1" },
      { backlogId: fixture.backlogB.id, name: "Foreign", color: "--label-2" },
      { backlogId: fixture.backlogA.id, name: "Local", color: "--label-3" },
    ]).returning();
    global = inserted[0]!; foreignId = inserted[1]!.id; localId = inserted[2]!.id;
  });
  afterAll(async () => {
    if (global) await db.delete(labels).where(eq(labels.id, global.id));
    if (fixture) {
      await db.delete(securityAuditEvents).where(inArray(securityAuditEvents.actorId, fixture.userIds));
      await deleteReadVisibilityFixture(fixture);
    }
  });
  it("reads local/global labels, masks invisible catalogues, and checks edit_items on every write", async () => {
    const response = await list(request("GET", undefined, readToken), context(fixture.backlogA.key));
    expect(response.status).toBe(200); expect((await response.json()).labels).toEqual(expect.arrayContaining([global, expect.objectContaining({ id: localId })]));
    for (const labelId of [global.id, localId]) {
      expect((await add(request("PUT"), context(fixture.liveA.key, labelId))).status).toBe(403);
      expect((await remove(request("DELETE"), context(fixture.liveA.key, labelId))).status).toBe(403);
      for (const name of ["add_item_label", "remove_item_label"]) expect((await tool(name, { key: fixture.liveA.key, labelId })).isError).toBe(true);
    }
    expect((await createLabel(request("POST", { name: "Denied" }), context(fixture.backlogA.key))).status).toBe(403);
    expect((await tool("create_label", { backlog: fixture.backlogA.key, name: "Denied" })).isError).toBe(true);
    const hidden = await list(request("GET", undefined, outsiderToken), context(fixture.backlogA.key));
    const absent = await list(request("GET", undefined, outsiderToken), context("UNKNOWN"));
    expect(hidden.status).toBe(404); expect(absent.status).toBe(404); expect(await hidden.json()).toEqual(await absent.json());
    const hiddenMcp = await tool("list_labels", { backlog: fixture.backlogA.key }, outsider);
    const absentMcp = await tool("list_labels", { backlog: "UNKNOWN" }, outsider);
    expect(hiddenMcp).toEqual(absentMcp); expect(hiddenMcp.isError).toBe(true);
  });
  it("creates with initial labels using create_items alone and deduplicates in both transports", async () => {
    const response = await createItem(request("POST", { backlogKey: fixture.backlogA.key, type: "composant", title: "REST labels", labelIds: [localId, localId, global.id] }));
    expect(response.status).toBe(201);
    const restItem = (await response.json()).item;
    const mcp = await tool("create_item", { backlog: fixture.backlogA.key, type: "composant", title: "MCP labels", labelIds: [global.id, global.id] });
    expect(mcp.isError).toBeUndefined();
    const mcpKey = (mcp.structuredContent!.item as { key: string }).key;
    const read = (await tool("get_item", { key: mcpKey }, reader)).structuredContent!.item as { labels: { id: string }[]; children: unknown[] };
    expect(read.labels).toEqual([expect.objectContaining({ id: global.id })]); expect(read.children).toEqual([]);
    expect((await (await detail(request(), context(restItem.key))).json()).item.labels).toHaveLength(2);
    for (const labelId of [foreignId, randomUUID()]) {
      const rejected = await createItem(request("POST", { backlogKey: fixture.backlogA.key, type: "composant", title: "Rejected", labelIds: [labelId] }));
      expect(rejected.status).toBe(404);
      expect((await tool("create_item", { backlog: fixture.backlogA.key, type: "composant", title: "Rejected", labelIds: [labelId] })).isError).toBe(true);
    }
  });
  it("refuses read tokens on catalogue, deltas and initial-label creation", async () => {
    expect((await createLabel(request("POST", { name: "Denied" }, readToken), context(fixture.backlogA.key))).status).toBe(403);
    expect((await add(request("PUT", undefined, readToken), context(fixture.liveA.key, global.id))).status).toBe(403);
    expect((await remove(request("DELETE", undefined, readToken), context(fixture.liveA.key, global.id))).status).toBe(403);
    expect((await createItem(request("POST", { backlogKey: fixture.backlogA.key, type: "composant", title: "Denied", labelIds: [global.id] }, readToken))).status).toBe(403);
    for (const name of ["create_label", "add_item_label", "remove_item_label", "create_item"]) {
      expect((await tool(name, { backlog: fixture.backlogA.key, key: fixture.liveA.key, name: "Denied", labelId: global.id, type: "composant", title: "Denied", labelIds: [global.id] }, reader)).isError).toBe(true);
    }
  });
  it("reuses a global catalogue name, applies deltas across transports and logs only changes", async () => {
    await db.insert(permissionGrants).values({ scope: "backlog", permissionSchemeId: fixture.schemeIds[0], permissionKey: "edit_items", principalType: "user", userId: fixture.actorA });
    const reused = await createLabel(request("POST", { name: global.name.toUpperCase() }), context(fixture.backlogA.key));
    expect(reused.status).toBe(200); expect(await reused.json()).toEqual({ label: global, created: false });
    expect((await tool("create_label", { backlog: fixture.backlogA.key, name: global.name })).structuredContent).toEqual({ label: global, created: false });
    expect((await tool("remove_item_label", { key: fixture.liveA.key, labelId: global.id })).structuredContent).toEqual({ changed: false });
    expect((await add(request("PUT"), context(fixture.liveA.key, global.id))).status).toBe(204);
    expect((await tool("add_item_label", { key: fixture.liveA.key, labelId: global.id })).structuredContent).toEqual({ changed: false });
    expect((await tool("remove_item_label", { key: fixture.liveA.key, labelId: global.id })).structuredContent).toEqual({ changed: true });
    expect((await remove(request("DELETE"), context(fixture.liveA.key, global.id))).status).toBe(204);
    const rows = await db.select().from(activities).where(and(eq(activities.itemId, fixture.liveA.id), eq(activities.field, "labels")));
    expect(rows).toHaveLength(2); expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "api", tokenId: writer.tokenId, newValue: global.id }),
      expect.objectContaining({ source: "mcp", tokenId: writer.tokenId, oldValue: global.id }),
    ]));
    expect(await db.select().from(itemLabels).where(eq(itemLabels.itemId, fixture.liveA.id))).toEqual([]);
  });
  it("returns the same 404 for foreign and unknown labels on each delta, with no extra activity", async () => {
    for (const handler of [add, remove]) {
      const responses = [];
      for (const id of [foreignId, randomUUID()]) {
        const response = await handler(request(handler === add ? "PUT" : "DELETE"), context(fixture.liveA.key, id));
        expect(response.status).toBe(404); responses.push(await response.json());
      }
      expect(responses[0]).toEqual(responses[1]);
    }
    for (const name of ["add_item_label", "remove_item_label"]) {
      const foreign = await tool(name, { key: fixture.liveA.key, labelId: foreignId });
      const unknown = await tool(name, { key: fixture.liveA.key, labelId: randomUUID() });
      expect(foreign).toEqual(unknown); expect(foreign.isError).toBe(true);
    }
    expect(await db.select().from(activities).where(and(eq(activities.itemId, fixture.liveA.id), eq(activities.field, "labels")))).toHaveLength(2);
  });
});
