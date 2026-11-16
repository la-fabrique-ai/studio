import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText, Folder } from "lucide-react";
import { SpecDocumentEditor } from "@/components/specs/spec-document-editor";
import { EmptyState } from "@/components/ui/empty-state";
import { getBacklogCapabilities } from "@/lib/auth/accessible-backlogs";
import { projectBacklogCapabilities } from "@/lib/auth/capabilities";
import { requireAppPageSession } from "@/lib/auth/session";
import { getBacklogByKeyForUser } from "@/lib/services/backlogs";
import { getSpecNode, listSpecNodes } from "@/lib/services/specs";
import { ancestorsOf } from "@/lib/specs/tree";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" });

export default async function SpecNodePage({ params }: { params: Promise<{ key: string; id: string }> }) {
  const { key, id } = await params;
  if (!UUID.test(id)) notFound();
  const session = await requireAppPageSession();
  const backlog = await getBacklogByKeyForUser(key, session.user.id);
  if (!backlog || backlog.archivedAt) notFound();
  const rawCapabilities = await getBacklogCapabilities(session.user.id, backlog.id);
  if (!rawCapabilities) notFound();
  const canEdit = projectBacklogCapabilities(rawCapabilities).items.edit;
  const [node, nodes] = await Promise.all([getSpecNode(backlog.id, id), listSpecNodes(backlog.id)]);
  if (!node) notFound();

  const base = `/b/${backlog.key}/specs`;
  const path = ancestorsOf(nodes, node.id).slice(0, -1);

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1 border-b border-border pb-3">
        {path.length > 0 ? (
          <nav aria-label="Dossiers" className="text-[13px] text-muted-foreground">
            {path.map((folder, index) => (
              <span key={folder.id}>
                {index > 0 ? " / " : null}
                <Link href={`${base}/${folder.id}`} className="hover:text-foreground hover:underline">{folder.title}</Link>
              </span>
            ))}
          </nav>
        ) : null}
        <h2 className="t-h1 break-words">{node.title}</h2>
        {node.kind === "document" ? (
          <p className="text-xs text-muted-foreground">
            Modifié le {dateFormat.format(node.updatedAt)}{node.updatedByName ? ` par ${node.updatedByName}` : null}
          </p>
        ) : null}
      </header>
      {node.kind === "document" ? (
        <SpecDocumentEditor
          backlogKey={backlog.key}
          id={node.id}
          currentUserId={session.user.id}
          content={node.content}
          revision={node.updatedAt.toISOString()}
          readOnly={!canEdit}
        />
      ) : (
        <FolderContents base={base} entries={nodes.filter((n) => n.parentId === node.id)} />
      )}
    </article>
  );
}

function FolderContents({ base, entries }: { base: string; entries: { id: string; kind: "folder" | "document"; title: string }[] }) {
  if (entries.length === 0) {
    return (
      <EmptyState
        className="mx-auto py-10"
        icon={<Folder className="size-5" />}
        title="Dossier vide"
        description="Ajoutez un document ou un sous-dossier depuis le menu « … » du dossier dans l’arborescence."
      />
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border rounded-[var(--radius)] border border-border">
      {entries.map((child) => {
        const Icon = child.kind === "folder" ? Folder : FileText;
        return (
          <li key={child.id}>
            <Link href={`${base}/${child.id}`} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-[var(--muted)]">
              <Icon aria-hidden className="size-4 text-muted-foreground" />
              <span className="truncate">{child.title}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
