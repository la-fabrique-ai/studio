import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema/auth";
import { activities, apiTokens, itemCreationRequests, items, labels, permissionGrants, securityAuditEvents } from "@/lib/db/schema/domain";
import { createApiToken, type ApiPrincipal } from "@/lib/services/api-tokens";
import { createReadVisibilityFixture, deleteReadVisibilityFixture, type ReadVisibilityFixture } from "@/lib/services/read-visibility.integration-fixture";
vi.mock("@/lib/realtime/publish", () => ({ publishBacklogChange: vi.fn(), notifyUsers: vi.fn() }));
import { POST } from "@/app/api/v1/items/route";
import { publishBacklogChange } from "@/lib/realtime/publish";
import { STUDIO_TOOLS, runTool } from "@/lib/mcp/tools";
const describeDb = process.env.JIROO_RUN_DB_TESTS === "1" ? describe : describe.skip;
describeDb("durable item creation requests across REST and MCP", () => {
  let f: ReadVisibilityFixture;
  let bearer: string; let readerBearer: string; let writer: ApiPrincipal; let reader: ApiPrincipal;
  const command = (extra = {}) => ({ backlogKey: f.backlogA.key, type: "composant", title: "Idempotent root", ...extra });
  const post = (body: unknown, key?: string, token = bearer) => POST(new Request("http://localhost/api/v1/items", {
    method: "POST", headers: { authorization: `Bearer ${token}`, ...(key === undefined ? {} : { "Idempotency-Key": key }) }, body: JSON.stringify(body),
  }));
  const mcp = (body: ReturnType<typeof command>, idempotencyKey?: string, principal = writer) => {
    const { backlogKey, ...fields } = body;
    return runTool(STUDIO_TOOLS.find((t) => t.name === "create_item")!, { ...fields, backlog: backlogKey, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }, principal);
  };
  const reservation = async (key: string) => (await db.select().from(itemCreationRequests).where(and(eq(itemCreationRequests.actorId, f.actorA), eq(itemCreationRequests.backlogId, f.backlogA.id), eq(itemCreationRequests.key, key))))[0];
  const assertSingle = async (key: string, itemId: string) => {
    expect(await reservation(key)).toMatchObject({ itemId });
    expect(await db.select().from(items).where(eq(items.id, itemId))).toHaveLength(1);
    const journal = await db.select().from(activities).where(eq(activities.itemId, itemId));
    expect(journal).toHaveLength(1); expect(journal[0]).toMatchObject({ action: "create", actorId: f.actorA });
  };
  beforeAll(async () => {
    f = await createReadVisibilityFixture("Idempotent creation");
    // Fixture keys use timestamp suffixes; creation keys must fit the public contract.
    await db.update(items).set({ key: `${f.backlogA.key}-1` }).where(eq(items.id, f.liveA.id));
    await db.update(items).set({ key: `${f.backlogA.key}-2` }).where(eq(items.id, f.trashA.id));
    await db.update(items).set({ key: `${f.backlogB.key}-1` }).where(eq(items.id, f.liveB.id));
    await db.update(items).set({ key: `${f.backlogB.key}-2` }).where(eq(items.id, f.trashB.id));
    await db.update(user).set({ twoFactorEnabled: true }).where(inArray(user.id, [f.actorA, f.actorB]));
    for (const schemeId of f.schemeIds) for (const actorId of [f.actorA, f.actorB]) {
      for (const permissionKey of ["browse_backlog", "create_items", "schedule_items", "assign_items"] as const) {
        // The fixture already grants browse for each actor's own backlog.
        if (permissionKey === "browse_backlog" && ((actorId === f.actorA && schemeId === f.schemeIds[0]) || (actorId === f.actorB && schemeId === f.schemeIds[1]))) continue;
        await db.insert(permissionGrants).values({ scope: "backlog", permissionSchemeId: schemeId, permissionKey, principalType: "user", userId: actorId });
      }
    }
    for (const scope of ["write", "read"] as const) {
      const issued = await createApiToken({ name: `Creation ${scope}`, scope, expiresInDays: 30 }, f.actorA, { authVersion: 0 });
      const principal = { actorId: f.actorA, tokenId: issued.row.id, scope };
      if (scope === "write") { bearer = issued.token; writer = principal; } else { readerBearer = issued.token; reader = principal; }
    }
  });
  afterAll(async () => {
    if (f) { await db.delete(securityAuditEvents).where(inArray(securityAuditEvents.actorId, f.userIds)); await deleteReadVisibilityFixture(f); }
  });
  it("replays sequentially and in both REST/MCP directions with one item and activity", async () => {
    for (const firstTransport of ["rest", "mcp"]) {
      const key = randomUUID(); const body = command();
      const initial = firstTransport === "rest" ? await (await post(body, key)).json() : (await mcp(body, key)).structuredContent!;
      expect(initial.replayed).toBe(false);
      const response = await post(body, key); expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ item: { id: initial.item.id }, replayed: true });
      expect((await mcp(body, key)).structuredContent).toMatchObject({ item: { id: initial.item.id }, replayed: true });
      await assertSingle(key, initial.item.id);
    }
  });
  it("serializes simultaneous requests, including across transports", async () => {
    const key = randomUUID(); const body = command();
    const [a, b, c] = await Promise.all([post(body, key), post(body, key), mcp(body, key)]);
    const answers = [await a.json(), await b.json(), c.structuredContent!];
    expect(new Set(answers.map((r) => r.item.id)).size).toBe(1);
    expect(answers.filter((r) => r.replayed === false)).toHaveLength(1);
    expect([a.status, b.status].every((status) => status === 200 || status === 201)).toBe(true);
    await assertSingle(key, answers[0].item.id);
  });
  it("handles more concurrent callers than the pool has connections without starving authorization", async () => {
    const key = randomUUID(); const body = command();
    const responses = await Promise.all(Array.from({ length: 12 }, () => post(body, key)));
    const answers = await Promise.all(responses.map((response) => response.json()));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(11);
    expect(new Set(answers.map((r) => r.item.id)).size).toBe(1);
    await assertSingle(key, answers[0].item.id);
  }, 30_000);
  it("retains administrator bypass audits for a parented creation and replay", async () => {
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, f.platformAdmin));
    const token = await createApiToken({ name: "Admin creation", scope: "write", expiresInDays: 30 }, f.platformAdmin, { authVersion: 0 });
    const root = await (await post(command(), undefined, token.token)).json();
    const key = randomUUID(); const body = command({ type: "epic", parentKey: root.item.key });
    const first = await post(body, key, token.token); expect(first.status).toBe(201);
    const journalBefore = await db.select().from(securityAuditEvents).where(eq(securityAuditEvents.actorId, f.platformAdmin));
    expect(journalBefore.some((a) => a.action === "platform_administrator_bypass" && a.backlogId === f.backlogA.id)).toBe(true);
    vi.mocked(publishBacklogChange).mockClear();
    const replay = await post(body, key, token.token); expect(replay.status).toBe(200);
    expect(vi.mocked(publishBacklogChange)).not.toHaveBeenCalled();
    expect((await db.select().from(securityAuditEvents).where(eq(securityAuditEvents.actorId, f.platformAdmin))).length).toBeGreaterThan(journalBefore.length);
  }, 15_000);
  it("survives revocation and rotation of the token", async () => {
    const old = await createApiToken({ name: "Old", scope: "write", expiresInDays: 30 }, f.actorA, { authVersion: 0 });
    const key = randomUUID(); const first = await (await post(command(), key, old.token)).json();
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, old.row.id));
    expect((await post(command(), key, old.token)).status).toBe(401);
    expect((await mcp(command(), key)).structuredContent).toMatchObject({ item: { id: first.item.id }, replayed: true });
    await assertSingle(key, first.item.id);
  });
  it("conflicts on changed content or explicit defaults, without changing the reservation or journal", async () => {
    const key = randomUUID(); const first = await (await post(command(), key)).json(); const before = await reservation(key);
    for (const change of [{ title: "Different" }, { priority: 0 }, { labelIds: [] }]) {
      expect((await post(command(change), key)).status).toBe(409);
      expect((await mcp(command(change), key)).isError).toBe(true);
    }
    expect(await reservation(key)).toEqual(before); await assertSingle(key, first.item.id);
  });
  it("isolates users, backlogs and case-sensitive keys; omitting the key creates every time", async () => {
    const key = randomUUID(); const a = await (await post(command(), key)).json();
    const issued = await createApiToken({ name: "Other user", scope: "write", expiresInDays: 30 }, f.actorB, { authVersion: 0 });
    const b = await (await post(command(), key, issued.token)).json();
    const c = await (await post(command({ backlogKey: f.backlogB.key }), key)).json();
    const d = await (await post(command(), key.toUpperCase())).json();
    const e = await (await post(command())).json(); const g = await (await post(command())).json();
    expect(new Set([a, b, c, d, e, g].map((r) => r.item.id)).size).toBe(6);
    expect(await db.select().from(itemCreationRequests).where(inArray(itemCreationRequests.itemId, [e.item.id, g.item.id]))).toEqual([]);
  });
  it("rolls back the request and item on failure, then permits the same key after the cause is repaired", async () => {
    const key = randomUUID(); const labelId = randomUUID(); const body = command({ labelIds: [labelId] });
    const before = await db.select({ id: items.id }).from(items).where(eq(items.backlogId, f.backlogA.id));
    expect((await post(body, key)).status).toBe(404); expect(await reservation(key)).toBeUndefined();
    expect(await db.select({ id: items.id }).from(items).where(eq(items.backlogId, f.backlogA.id))).toEqual(before);
    await db.insert(labels).values({ id: labelId, backlogId: f.backlogA.id, name: `Repair ${key}`, color: "--label-1" });
    const response = await post(body, key); expect(response.status).toBe(201);
    await assertSingle(key, (await response.json()).item.id);
  });
  it("returns current state without resolving deleted original references", async () => {
    const root = await (await post(command())).json();
    const key = randomUUID(); const body = command({ type: "epic", parentKey: root.item.key });
    const first = await (await post(body, key)).json();
    await db.update(items).set({ title: "Edited" }).where(eq(items.id, first.item.id));
    await db.update(items).set({ deletedAt: new Date() }).where(eq(items.id, root.item.id));
    const response = await post(body, key); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ item: { id: first.item.id, title: "Edited" }, replayed: true });
    await assertSingle(key, first.item.id);
  });
  it("never recreates a soft-deleted or purged item, preserving the consumed key", async () => {
    const key = randomUUID(); const first = await (await post(command(), key)).json();
    await db.update(items).set({ deletedAt: new Date() }).where(eq(items.id, first.item.id));
    expect((await post(command(), key)).status).toBe(409);
    await db.delete(items).where(eq(items.id, first.item.id));
    expect(await reservation(key)).toMatchObject({ itemId: null, itemKey: first.item.key });
    expect((await post(command(), key)).status).toBe(409); expect((await mcp(command(), key)).isError).toBe(true);
  });
  it("validates header/body agreement, rejects read tokens and rechecks current permissions on replay", async () => {
    const key = randomUUID(); const body = command({ idempotencyKey: key });
    expect((await post(body, "different")).status).toBe(400); expect(await reservation(key)).toBeUndefined();
    const first = await post(body, key); expect(first.status).toBe(201); const initial = await first.json();
    expect((await post(body, key, readerBearer)).status).toBe(403); expect((await mcp(command(), key, reader)).isError).toBe(true);
    const [grant] = await db.delete(permissionGrants).where(and(eq(permissionGrants.userId, f.actorA), eq(permissionGrants.permissionSchemeId, f.schemeIds[0]!), eq(permissionGrants.permissionKey, "create_items"))).returning();
    try { expect((await post(body, key)).status).toBe(403); expect((await mcp(command(), key)).isError).toBe(true); }
    finally { await db.insert(permissionGrants).values(grant!); }
    const [browse] = await db.delete(permissionGrants).where(and(eq(permissionGrants.userId, f.actorA), eq(permissionGrants.permissionSchemeId, f.schemeIds[0]!), eq(permissionGrants.permissionKey, "browse_backlog"))).returning();
    try { expect((await post(body, key)).status).toBe(404); expect((await mcp(command(), key)).isError).toBe(true); }
    finally { await db.insert(permissionGrants).values(browse!); }
    await assertSingle(key, initial.item.id);
  });
});
