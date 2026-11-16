import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { runWithActor } from "@/lib/auth/actor-context";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema/auth";
import { backlogs, specActivities, specNodes } from "@/lib/db/schema/domain";
import { seedDefaultSpecFolders } from "@/lib/specs/seed";
import { buildSpecTree } from "@/lib/specs/tree";
import {
  createSpecNode,
  getSpecNode,
  listSpecNodes,
  moveSpecNode,
  renameSpecNode,
  restoreSpecNode,
  SpecConflictError,
  SpecRuleError,
  trashSpecNode,
  updateSpecContent,
} from "@/lib/services/specs";

const describeDb = process.env.STUDIO_RUN_DB_TESTS === "1" ? describe : describe.skip;

describeDb("specification tree service", () => {
  const actorId = `specs-${randomUUID()}`;
  const backlogId = randomUUID();
  const otherBacklogId = randomUUID();
  const create = (parentId: string | null, kind: "folder" | "document", title: string, inBacklog = backlogId) =>
    createSpecNode({ backlogId: inBacklog, parentId, kind, title }, actorId);
  const titles = async () => {
    const tree = buildSpecTree(await listSpecNodes(backlogId));
    const walk = (nodes: typeof tree): unknown[] => nodes.map((n) => (n.children.length ? [n.title, walk(n.children)] : n.title));
    return walk(tree);
  };

  beforeAll(async () => {
    await db.insert(user).values({ id: actorId, name: "Specs test", email: `${randomUUID()}@specs.test`, emailVerified: true });
    const suffix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    await db.insert(backlogs).values([
      { id: backlogId, key: `S${suffix}`, name: "Specs", color: "#475569" },
      { id: otherBacklogId, key: `O${suffix}`, name: "Other specs", color: "#475569" },
    ]);
    await db.transaction((tx) => seedDefaultSpecFolders(tx, backlogId));
  });

  afterAll(async () => {
    await db.delete(backlogs).where(eq(backlogs.id, backlogId));
    await db.delete(backlogs).where(eq(backlogs.id, otherBacklogId));
    await db.delete(user).where(eq(user.id, actorId));
  });

  it("starts with the BMAD folders", async () => {
    expect(await titles()).toEqual(["Brief", "PRD", "UX"]);
  });

  it("creates folders and documents in order, and journals them", async () => {
    const brief = (await listSpecNodes(backlogId)).find((n) => n.title === "Brief")!;
    const doc = await runWithActor({ actorId, source: "ui" }, () => create(brief.id, "document", "Contexte"));
    await create(brief.id, "folder", "Recherche");
    expect(await titles()).toEqual([["Brief", ["Contexte", "Recherche"]], "PRD", "UX"]);
    const [entry] = await db.select().from(specActivities).where(eq(specActivities.nodeId, doc.id));
    expect(entry).toMatchObject({ action: "create", actorId, newValue: "Contexte", source: "ui" });
    expect((await getSpecNode(backlogId, doc.id))?.content).toBe("");
  });

  it("creates a document with its text in one call, but never a folder with text", async () => {
    const created = await create(null, "document", "Note");
    expect((await getSpecNode(backlogId, created.id))?.content).toBe("");
    const filled = await createSpecNode({ backlogId, parentId: null, kind: "document", title: "Brief agent", content: "# Problème" }, actorId);
    expect((await getSpecNode(backlogId, filled.id))?.content).toBe("# Problème");
    await expect(createSpecNode({ backlogId, parentId: null, kind: "folder", title: "X", content: "y" }, actorId))
      .rejects.toMatchObject({ code: "folder_content", message: "Un dossier n’a pas de contenu : créez un document." });
    await trashSpecNode({ backlogId, id: created.id }, actorId);
    await trashSpecNode({ backlogId, id: filled.id }, actorId);
  });

  it("refuses a document as parent and a parent from another backlog", async () => {
    const doc = (await listSpecNodes(backlogId)).find((n) => n.title === "Contexte")!;
    await expect(create(doc.id, "document", "Enfant")).rejects.toMatchObject({ code: "parent_not_folder" });
    const foreign = await create(null, "folder", "Ailleurs", otherBacklogId);
    await expect(create(foreign.id, "document", "Fuite")).rejects.toBeInstanceOf(SpecRuleError);
  });

  it("renames, and ignores a rename to the same title", async () => {
    const ux = (await listSpecNodes(backlogId)).find((n) => n.title === "UX")!;
    expect(await renameSpecNode({ backlogId, id: ux.id, title: "  Expérience  " }, actorId)).toEqual({ changed: true });
    expect(await renameSpecNode({ backlogId, id: ux.id, title: "Expérience" }, actorId)).toEqual({ changed: false });
    await renameSpecNode({ backlogId, id: ux.id, title: "UX" }, actorId);
  });

  it("moves between folders and reorders, but never into its own subtree", async () => {
    const nodes = await listSpecNodes(backlogId);
    const find = (t: string) => nodes.find((n) => n.title === t)!;
    await moveSpecNode({ backlogId, id: find("Recherche").id, parentId: find("PRD").id, afterId: null }, actorId);
    expect(await titles()).toEqual([["Brief", ["Contexte"]], ["PRD", ["Recherche"]], "UX"]);
    await moveSpecNode({ backlogId, id: find("UX").id, parentId: null, afterId: null }, actorId);
    expect(await titles()).toEqual(["UX", ["Brief", ["Contexte"]], ["PRD", ["Recherche"]]]);
    await moveSpecNode({ backlogId, id: find("UX").id, parentId: null, afterId: find("PRD").id }, actorId);
    expect(await titles()).toEqual([["Brief", ["Contexte"]], ["PRD", ["Recherche"]], "UX"]);
    // Dropping a node where it already is changes nothing.
    expect(await moveSpecNode({ backlogId, id: find("UX").id, parentId: null, afterId: find("PRD").id }, actorId))
      .toEqual({ changed: false });
    await expect(moveSpecNode({ backlogId, id: find("PRD").id, parentId: find("Recherche").id, afterId: null }, actorId))
      .rejects.toMatchObject({ code: "cycle" });
  });

  it("saves content against the loaded revision and rejects a stale one", async () => {
    const doc = (await listSpecNodes(backlogId)).find((n) => n.title === "Contexte")!;
    const first = await updateSpecContent({ backlogId, id: doc.id, content: "# Problème", revision: doc.updatedAt }, actorId);
    expect(first.revision.getTime()).toBeGreaterThan(doc.updatedAt.getTime());
    const stale = updateSpecContent({ backlogId, id: doc.id, content: "écrasé", revision: doc.updatedAt }, actorId);
    await expect(stale).rejects.toBeInstanceOf(SpecConflictError);
    await expect(stale).rejects.toMatchObject({ current: { content: "# Problème" } });
    const same = await updateSpecContent({ backlogId, id: doc.id, content: "# Problème", revision: first.revision }, actorId);
    expect(same.revision.getTime()).toBe(first.revision.getTime());
  });

  it("refuses content on a folder", async () => {
    const prd = (await listSpecNodes(backlogId)).find((n) => n.title === "PRD")!;
    await expect(updateSpecContent({ backlogId, id: prd.id, content: "x", revision: prd.updatedAt }, actorId)).rejects.toThrow();
  });

  it("trashes a subtree and restores it in place", async () => {
    const prd = (await listSpecNodes(backlogId)).find((n) => n.title === "PRD")!;
    const { ids } = await trashSpecNode({ backlogId, id: prd.id }, actorId);
    expect(ids).toHaveLength(2);
    expect(await titles()).toEqual([["Brief", ["Contexte"]], "UX"]);
    expect(await getSpecNode(backlogId, prd.id)).toBeNull();
    await restoreSpecNode({ backlogId, id: prd.id }, actorId);
    expect(await titles()).toEqual([["Brief", ["Contexte"]], ["PRD", ["Recherche"]], "UX"]);
  });

  it("restores at the root when the parent is still in the trash", async () => {
    const nodes = await listSpecNodes(backlogId);
    const doc = nodes.find((n) => n.title === "Contexte")!;
    const brief = nodes.find((n) => n.title === "Brief")!;
    await trashSpecNode({ backlogId, id: doc.id }, actorId);
    await trashSpecNode({ backlogId, id: brief.id }, actorId);
    await restoreSpecNode({ backlogId, id: doc.id }, actorId);
    const [row] = await db.select().from(specNodes).where(eq(specNodes.id, doc.id));
    expect(row?.parentId).toBeNull();
    expect(row?.deletedAt).toBeNull();
  });
});
