import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@/lib/auth/actor-context";
import { ResourceNotFoundError } from "@/lib/auth/authorization";
import { db } from "@/lib/db";
import { backlogs } from "@/lib/db/schema/domain";
import { BACKLOG_KEY } from "@/lib/mcp/schemas";
import { resolveApiBacklog } from "@/lib/services/api-read";
import { listSpecNodes, SPEC_CONTENT_MAX, SpecRuleError } from "@/lib/services/specs";
import { findSpecByPath, flattenSpecTree, SPEC_TITLE_MAX } from "@/lib/specs/tree";
import { getSpecNodeUseCase } from "@/lib/use-cases/specs";

/**
 * Specifications for the REST API and the MCP server (lot 2): the views both
 * return and the inputs both accept, so the two stay word for word alike.
 */

export const SPEC_ID = z.uuid();
const title = z.string().trim().min(1).max(SPEC_TITLE_MAX);
const content = z.string().max(SPEC_CONTENT_MAX);
const path = z.string().trim().min(1).max(2000);

export const createSpecInput = z.object({
  /** The parent folder by id, or by title path (`PRD/Stories`); neither: the root. */
  parentId: SPEC_ID.nullable().optional(),
  parentPath: path.optional(),
  kind: z.enum(["folder", "document"]),
  title,
  content: content.optional(),
}).strict().refine((input) => !(input.parentId && input.parentPath), {
  message: "Indiquez parentId ou parentPath, pas les deux.",
});

export const updateSpecInput = z.object({
  title: title.optional(),
  content: content.optional(),
  /** The `revision` read with the document; required to change its text. */
  revision: z.iso.datetime().optional(),
}).strict()
  .refine((input) => input.title !== undefined || input.content !== undefined, {
    message: "Indiquez title ou content.",
  })
  .refine((input) => input.content === undefined || input.revision !== undefined, {
    message: "La révision lue est requise pour modifier le contenu.",
    path: ["revision"],
  });

export const moveSpecInput = z.object({
  parentId: SPEC_ID.nullable(),
  afterId: SPEC_ID.nullable().optional(),
}).strict();

export type SpecListEntry = {
  id: string;
  parentId: string | null;
  kind: "folder" | "document";
  title: string;
  path: string;
  depth: number;
  updatedAt: string;
};

export type SpecNodeView = {
  id: string;
  backlog: { id: string; key: string };
  parentId: string | null;
  kind: "folder" | "document";
  title: string;
  path: string;
  updatedAt: string;
  updatedBy: { name: string } | null;
  /** Documents only: the Markdown text and the revision to send back to change it. */
  content?: string;
  revision?: string;
  /** Folders only: direct children, in order. */
  children?: { id: string; kind: "folder" | "document"; title: string }[];
};

/** The whole tree of a readable backlog, in tree order. */
export async function listApiSpecs(actor: Actor, backlogKey: string): Promise<{ backlog: { id: string; key: string }; nodes: SpecListEntry[] }> {
  // resolveApiBacklog checks browse_backlog (and audits an administrator once).
  const backlog = await resolveApiBacklog(actor.actorId, backlogKey);
  const nodes = await listSpecNodes(backlog.backlogId);
  return {
    backlog: { id: backlog.backlogId, key: backlog.backlogKey },
    nodes: flattenSpecTree(nodes).map((node) => ({
      id: node.id,
      parentId: node.parentId,
      kind: node.kind,
      title: node.title,
      path: node.path,
      depth: node.depth,
      updatedAt: node.updatedAt.toISOString(),
    })),
  };
}

/** One live node; trashed or unreadable answers « not found ». */
export async function getApiSpec(actor: Actor, id: string): Promise<SpecNodeView> {
  const node = await getSpecNodeUseCase(actor, SPEC_ID.parse(id));
  if (!node) throw new ResourceNotFoundError("spec_node", id);
  const [nodes, [backlog]] = await Promise.all([
    listSpecNodes(node.backlogId),
    db.select({ key: backlogs.key }).from(backlogs).where(eq(backlogs.id, node.backlogId)).limit(1),
  ]);
  const flat = flattenSpecTree(nodes);
  const view: SpecNodeView = {
    id: node.id,
    backlog: { id: node.backlogId, key: backlog?.key ?? "" },
    parentId: node.parentId,
    kind: node.kind,
    title: node.title,
    path: flat.find((entry) => entry.id === node.id)?.path ?? node.title,
    updatedAt: node.updatedAt.toISOString(),
    updatedBy: node.updatedByName ? { name: node.updatedByName } : null,
  };
  if (node.kind === "document") {
    view.content = node.content;
    view.revision = node.updatedAt.toISOString();
  } else {
    view.children = flat
      .filter((entry) => entry.parentId === node.id)
      .map((entry) => ({ id: entry.id, kind: entry.kind, title: entry.title }));
  }
  return view;
}

/** A node of a readable backlog named by its title path (`PRD/Stories/Story 1`). */
export async function findApiSpecIdByPath(actor: Actor, backlogKey: string, specPath: string): Promise<{ backlogId: string; id: string }> {
  const backlog = await resolveApiBacklog(actor.actorId, backlogKey);
  return { backlogId: backlog.backlogId, id: await findSpecIdInBacklog(backlog.backlogId, specPath) };
}

/** The node at a title path of a backlog the caller already authorized. */
export async function findSpecIdInBacklog(backlogId: string, specPath: string): Promise<string> {
  const found = findSpecByPath(await listSpecNodes(backlogId), path.parse(specPath));
  if (found.ok) return found.id;
  if (found.reason === "ambiguous") throw new SpecRuleError("ambiguous_path");
  throw new ResourceNotFoundError("spec_node", specPath);
}

// MCP inputs: the REST shapes plus the backlog or node the URL carries there.
const SPEC_BACKLOG = BACKLOG_KEY.describe("Backlog key, such as CASS.");
const SPEC_NODE_ID = SPEC_ID.describe("A specification node id, from list_specs or get_spec.");

export const listSpecsToolInput = z.object({ backlog: SPEC_BACKLOG }).strict();

export const getSpecToolInput = z.object({
  id: SPEC_NODE_ID.optional(),
  backlog: SPEC_BACKLOG.optional(),
  path: path.describe("Title path from the root, such as PRD/Stories/Story 1 (with backlog).").optional(),
}).strict().refine((input) => input.id !== undefined || (input.backlog !== undefined && input.path !== undefined), {
  message: "Indiquez id, ou backlog et path.",
});

export const createSpecToolInput = z.object({
  backlog: SPEC_BACKLOG,
  parentId: SPEC_NODE_ID.nullable().optional(),
  parentPath: path.describe("Parent folder by title path, such as PRD/Stories. Omit both parents for the root.").optional(),
  kind: z.enum(["folder", "document"]).describe("folder holds other nodes; document holds Markdown."),
  title,
  content: content.describe("Markdown text of a document.").optional(),
}).strict().refine((input) => !(input.parentId && input.parentPath), {
  message: "Indiquez parentId ou parentPath, pas les deux.",
});

export const updateSpecToolInput = z.object({
  id: SPEC_NODE_ID,
  title: title.optional(),
  content: content.describe("The whole new Markdown text (it replaces the old one).").optional(),
  revision: z.iso.datetime().describe("The revision returned by get_spec; required with content.").optional(),
}).strict()
  .refine((input) => input.title !== undefined || input.content !== undefined, { message: "Indiquez title ou content." })
  .refine((input) => input.content === undefined || input.revision !== undefined, {
    message: "La révision lue est requise pour modifier le contenu.",
    path: ["revision"],
  });

export const moveSpecToolInput = z.object({
  id: SPEC_NODE_ID,
  parentId: SPEC_NODE_ID.nullable().describe("The new parent folder; null for the root."),
  afterId: SPEC_NODE_ID.nullable().describe("The sibling to place it after; null or absent for first.").optional(),
}).strict();

export const specNodeToolInput = z.object({ id: SPEC_NODE_ID }).strict();
