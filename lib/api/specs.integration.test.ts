import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const published = vi.hoisted(() => vi.fn());
vi.mock("@/lib/realtime/publish", () => ({ publishBacklogChange: published, notifyUsers: vi.fn() }));
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema/auth";
import { permissionGrants, securityAuditEvents, specActivities, specNodes } from "@/lib/db/schema/domain";
import { createApiToken, type ApiPrincipal } from "@/lib/services/api-tokens";
import { createReadVisibilityFixture, deleteReadVisibilityFixture, type ReadVisibilityFixture } from "@/lib/services/read-visibility.integration-fixture";
import { GET as listSpecs, POST as createSpec } from "@/app/api/v1/backlogs/[key]/specs/route";
import { GET as lookupSpec } from "@/app/api/v1/backlogs/[key]/specs/lookup/route";
import { DELETE as deleteSpec, GET as getSpec, PATCH as patchSpec } from "@/app/api/v1/specs/[id]/route";
import { POST as moveSpec } from "@/app/api/v1/specs/[id]/move/route";
import { POST as restoreSpec } from "@/app/api/v1/specs/[id]/restore/route";
import { STUDIO_TOOLS, runTool } from "@/lib/mcp/tools";

const describeDb = process.env.STUDIO_RUN_DB_TESTS === "1" ? describe : describe.skip;

describeDb("specifications across REST and MCP with real permissions", () => {
  let fixture: ReadVisibilityFixture;
  let token: string; let readToken: string; let outsiderToken: string;
  let writer: ApiPrincipal; let outsider: ApiPrincipal;
  const request = (method = "GET", body?: unknown, bearer = token, url = "http://localhost/api/v1") =>
    new Request(url, { method, headers: { authorization: `Bearer ${bearer}` }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  const byKey = (key: string) => ({ params: Promise.resolve({ key }) });
  const byId = (id: string) => ({ params: Promise.resolve({ id }) });
  const tool = (name: string, input: unknown, principal = writer) =>
    runTool(STUDIO_TOOLS.find((entry) => entry.name === name)!, input, principal);

  beforeAll(async () => {
    fixture = await createReadVisibilityFixture("API specs");
    await db.update(user).set({ twoFactorEnabled: true }).where(inArray(user.id, [fixture.actorA, fixture.actorB]));
    for (const [scope, actorId] of [["write", fixture.actorA], ["read", fixture.actorA], ["write", fixture.actorB]] as const) {
      const issued = await createApiToken({ name: `Specs ${scope}`, scope, expiresInDays: 30 }, actorId, { authVersion: 0 });
      const principal = { actorId, tokenId: issued.row.id, scope };
      if (actorId === fixture.actorB) { outsiderToken = issued.token; outsider = principal; }
      else if (scope === "write") { token = issued.token; writer = principal; }
      else { readToken = issued.token; }
    }
  });

  afterAll(async () => {
    if (!fixture) return;
    await db.delete(specNodes).where(inArray(specNodes.backlogId, [fixture.backlogA.id, fixture.backlogB.id]));
    await db.delete(securityAuditEvents).where(inArray(securityAuditEvents.actorId, fixture.userIds));
    await deleteReadVisibilityFixture(fixture);
  });

  it("reads with browse_backlog, writes only with edit_items and a write token", async () => {
    const empty = await listSpecs(request("GET", undefined, readToken), byKey(fixture.backlogA.key));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ backlog: { id: fixture.backlogA.id, key: fixture.backlogA.key }, nodes: [] });

    const denied = await createSpec(request("POST", { kind: "folder", title: "PRD" }), byKey(fixture.backlogA.key));
    expect(denied.status).toBe(403);
    expect((await tool("create_spec", { backlog: fixture.backlogA.key, kind: "folder", title: "PRD" })).isError).toBe(true);

    await db.insert(permissionGrants).values({
      scope: "backlog", permissionSchemeId: fixture.schemeIds[0], permissionKey: "edit_items", principalType: "user", userId: fixture.actorA,
    });
    const readOnly = await createSpec(request("POST", { kind: "folder", title: "PRD" }, readToken), byKey(fixture.backlogA.key));
    expect(readOnly.status).toBe(403);
    expect((await readOnly.json()).type).toContain("insufficient_scope");
  });

  it("creates a tree, finds a document by path and edits it against its revision", async () => {
    const folder = await createSpec(request("POST", { kind: "folder", title: "PRD" }), byKey(fixture.backlogA.key));
    expect(folder.status).toBe(201);
    const created = await createSpec(
      request("POST", { kind: "document", title: "Story 1", parentPath: "prd", content: "# Quotas" }),
      byKey(fixture.backlogA.key.toLowerCase()),
    );
    expect(created.status).toBe(201);
    const { node } = await created.json();
    expect(node).toMatchObject({ kind: "document", title: "Story 1", path: "PRD/Story 1", content: "# Quotas", backlog: { key: fixture.backlogA.key } });

    const found = await lookupSpec(
      request("GET", undefined, readToken, `http://localhost/api/v1/backlogs/x/specs/lookup?path=${encodeURIComponent("PRD/Story 1")}`),
      byKey(fixture.backlogA.key),
    );
    expect((await found.json()).node.id).toBe(node.id);

    const saved = await patchSpec(request("PATCH", { content: "# Quotas v2", revision: node.revision }), byId(node.id));
    expect(saved.status).toBe(200);
    const after = (await saved.json()).node;
    expect(after.content).toBe("# Quotas v2");

    // The first revision is stale now: 409, the current one to read again, nothing written.
    const stale = await patchSpec(request("PATCH", { content: "écrasé", title: "Renommé", revision: node.revision }), byId(node.id));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ currentRevision: after.revision, detail: "Ce document a été modifié entre-temps." });
    expect((await (await getSpec(request("GET", undefined, readToken), byId(node.id))).json()).node)
      .toMatchObject({ content: "# Quotas v2", title: "Story 1" });

    const noRevision = await patchSpec(request("PATCH", { content: "x" }), byId(node.id));
    expect(noRevision.status).toBe(400);

    const journal = await db.select().from(specActivities).where(and(eq(specActivities.nodeId, node.id), eq(specActivities.field, "content")));
    expect(journal).toEqual([expect.objectContaining({ source: "api", tokenId: writer.tokenId })]);
    expect(published).toHaveBeenCalledWith({ kind: "backlog", backlogId: fixture.backlogA.id, actorId: fixture.actorA });
  });

  it("accepts a long document up to 1 MB, and no more", async () => {
    const big = "a".repeat(200 * 1024);
    const created = await createSpec(request("POST", { kind: "document", title: "Long", content: big }), byKey(fixture.backlogA.key));
    expect(created.status).toBe(201);
    const tooBig = await createSpec(request("POST", { kind: "document", title: "Trop long", content: "a".repeat(1100 * 1024) }), byKey(fixture.backlogA.key));
    expect(tooBig.status).toBe(413);
  });

  it("moves, trashes and restores, and refuses a folder inside itself", async () => {
    const { nodes } = await (await listSpecs(request("GET"), byKey(fixture.backlogA.key))).json();
    const prd = nodes.find((n: { path: string }) => n.path === "PRD");
    const story = nodes.find((n: { path: string }) => n.path === "PRD/Story 1");

    const cycle = await moveSpec(request("POST", { parentId: story.id }), byId(prd.id));
    expect(cycle.status).toBe(409);
    expect((await cycle.json()).detail).toBe("Un document ne peut pas contenir d’autres éléments.");

    const moved = await moveSpec(request("POST", { parentId: null, afterId: null }), byId(story.id));
    expect((await moved.json()).node.path).toBe("Story 1");

    const trashed = await deleteSpec(request("DELETE"), byId(prd.id));
    expect(await trashed.json()).toEqual({ trashedIds: [prd.id] });
    expect((await getSpec(request("GET"), byId(prd.id))).status).toBe(404);
    const restored = await restoreSpec(request("POST"), byId(prd.id));
    expect((await restored.json()).node).toMatchObject({ id: prd.id, kind: "folder", children: [] });
  });

  it("hides another backlog's specifications like unknown ones", async () => {
    const { nodes } = await (await listSpecs(request("GET"), byKey(fixture.backlogA.key))).json();
    const id = nodes[0].id;
    const hidden = await getSpec(request("GET", undefined, outsiderToken), byId(id));
    const absent = await getSpec(request("GET", undefined, outsiderToken), byId("00000000-0000-4000-8000-000000000000"));
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await absent.json());
    expect((await listSpecs(request("GET", undefined, outsiderToken), byKey(fixture.backlogA.key))).status).toBe(404);
    expect((await patchSpec(request("PATCH", { title: "Volé" }, outsiderToken), byId(id))).status).toBe(404);
    const viaMcp = await tool("get_spec", { id }, outsider);
    expect(viaMcp).toMatchObject({ isError: true });
  });

  it("works through the MCP tools, conflict included", async () => {
    const created = await tool("create_spec", { backlog: fixture.backlogA.key, kind: "document", title: "Brief", content: "v1" });
    expect(created.isError).toBeUndefined();
    const node = (created.structuredContent as { node: { id: string; revision: string } }).node;

    const read = await tool("get_spec", { backlog: fixture.backlogA.key, path: "brief" });
    expect(read.structuredContent).toMatchObject({ node: { id: node.id, content: "v1" } });

    const updated = await tool("update_spec", { id: node.id, content: "v2", revision: node.revision });
    expect(updated.structuredContent).toMatchObject({ node: { content: "v2" } });
    const stale = await tool("update_spec", { id: node.id, content: "v3", revision: node.revision });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain("Révision actuelle");

    const journal = await db.select().from(specActivities).where(and(eq(specActivities.nodeId, node.id), eq(specActivities.field, "content")));
    expect(journal).toEqual([expect.objectContaining({ source: "mcp", tokenId: writer.tokenId })]);

    const listed = await tool("list_specs", { backlog: fixture.backlogA.key });
    expect((listed.structuredContent as { nodes: { title: string }[] }).nodes.map((n) => n.title)).toContain("Brief");
  });
});
