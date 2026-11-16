/**
 * Pure rules of the specification tree (Spécifications): a per-backlog tree
 * of folders and Markdown documents, where only folders have children — the
 * simple form of Confluence's page tree that Jira's Docs tab shows.
 */

export type SpecNodeKind = "folder" | "document";

export type SpecTreeNode = {
  id: string;
  parentId: string | null;
  kind: SpecNodeKind;
  title: string;
  rank: string;
};

export type SpecTree<T extends SpecTreeNode = SpecTreeNode> = T & { children: SpecTree<T>[] };

/** The BMAD folders every backlog starts with; they stay free to rename or remove. */
export const DEFAULT_SPEC_FOLDERS = ["Brief", "PRD", "UX"] as const;

export const SPEC_TITLE_MAX = 200;

export type SpecMoveError = "parent_not_found" | "parent_not_folder" | "cycle";

const byRank = (a: SpecTreeNode, b: SpecTreeNode) =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Nests live nodes under their parent, siblings by rank; orphans are left out. */
export function buildSpecTree<T extends SpecTreeNode>(nodes: readonly T[]): SpecTree<T>[] {
  const byParent = new Map<string | null, T[]>();
  for (const node of nodes) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }
  const build = (parentId: string | null): SpecTree<T>[] =>
    (byParent.get(parentId) ?? [])
      .sort(byRank)
      .map((node) => ({ ...node, children: node.kind === "folder" ? build(node.id) : [] }));
  return build(null);
}

/** The node and every node below it. */
export function descendantIds(nodes: readonly SpecTreeNode[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
  }
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    out.push(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

/** Path from the root down to the node, the node included (breadcrumb). */
export function ancestorsOf<T extends SpecTreeNode>(nodes: readonly T[], id: string): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: T[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path;
}

/** Why moving `nodeId` under `parentId` (null: the root) is refused, or null. */
export function checkSpecMove(
  nodes: readonly SpecTreeNode[],
  nodeId: string,
  parentId: string | null,
): SpecMoveError | null {
  if (parentId === null) return null;
  if (parentId === nodeId) return "cycle";
  const parent = nodes.find((node) => node.id === parentId);
  if (!parent) return "parent_not_found";
  if (parent.kind !== "folder") return "parent_not_folder";
  if (descendantIds(nodes, nodeId).includes(parentId)) return "cycle";
  return null;
}

export type FlatSpecNode<T extends SpecTreeNode = SpecTreeNode> = T & { path: string; depth: number };

/** Nodes in tree order (depth first), each with its slash-separated title path. */
export function flattenSpecTree<T extends SpecTreeNode>(nodes: readonly T[]): FlatSpecNode<T>[] {
  const out: FlatSpecNode<T>[] = [];
  const walk = (level: SpecTree<T>[], prefix: string, depth: number) => {
    for (const { children, ...node } of level) {
      const path = prefix ? `${prefix}/${node.title}` : node.title;
      out.push({ ...(node as unknown as T), path, depth });
      walk(children, path, depth + 1);
    }
  };
  walk(buildSpecTree(nodes), "", 0);
  return out;
}

export type SpecPathLookup = { ok: true; id: string } | { ok: false; reason: "not_found" | "ambiguous" };

/**
 * Finds a node from its title path (`PRD/Stories/Story 1`), as agents name
 * documents. Segments are trimmed; an exact title wins, otherwise a single
 * case-insensitive match does. A title containing « / » cannot be reached by
 * path (use its id).
 */
export function findSpecByPath(nodes: readonly SpecTreeNode[], path: string): SpecPathLookup {
  const segments = path.split("/").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return { ok: false, reason: "not_found" };
  let parentId: string | null = null;
  let found: SpecTreeNode | undefined;
  for (const segment of segments) {
    const siblings = nodes.filter((node) => node.parentId === parentId);
    const exact = siblings.filter((node) => node.title.trim() === segment);
    const loose = exact.length > 0
      ? exact
      : siblings.filter((node) => node.title.trim().toLocaleLowerCase("fr") === segment.toLocaleLowerCase("fr"));
    if (loose.length === 0) return { ok: false, reason: "not_found" };
    if (loose.length > 1) return { ok: false, reason: "ambiguous" };
    found = loose[0]!;
    parentId = found.id;
  }
  return { ok: true, id: found!.id };
}
