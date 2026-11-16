import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/shell/page-header";
import { SpecTree } from "@/components/specs/spec-tree";
import { getBacklogCapabilities } from "@/lib/auth/accessible-backlogs";
import { projectBacklogCapabilities } from "@/lib/auth/capabilities";
import { requireAppPageSession } from "@/lib/auth/session";
import { getBacklogByKeyForUser } from "@/lib/services/backlogs";
import { listSpecNodes } from "@/lib/services/specs";

/**
 * Spécifications: the backlog's folder tree on the left, the open document
 * on the right (Jira's Docs tab over a Confluence page tree, simplified).
 */
export default async function SpecsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const session = await requireAppPageSession();
  const backlog = await getBacklogByKeyForUser(key, session.user.id);
  if (!backlog || backlog.archivedAt) notFound();
  const rawCapabilities = await getBacklogCapabilities(session.user.id, backlog.id);
  if (!rawCapabilities) notFound();
  const canEdit = projectBacklogCapabilities(rawCapabilities).items.edit;
  const nodes = await listSpecNodes(backlog.id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Spécifications" />
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pb-6 sm:px-6 md:flex-row">
        <aside className="flex shrink-0 flex-col md:sticky md:top-0 md:max-h-full md:w-64 md:overflow-y-auto">
          <SpecTree
            backlogKey={backlog.key}
            backlogId={backlog.id}
            nodes={nodes.map(({ id, parentId, kind, title, rank }) => ({ id, parentId, kind, title, rank }))}
            canEdit={canEdit}
          />
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
