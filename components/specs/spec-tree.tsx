"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  createSpecNodeAction,
  moveSpecNodeAction,
  renameSpecNodeAction,
  restoreSpecNodeAction,
  trashSpecNodeAction,
} from "@/app/actions/specs";
import { SpecNodeDialog, type SpecNodeDialogRequest } from "@/components/specs/spec-node-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ancestorsOf, buildSpecTree, checkSpecMove, descendantIds, type SpecTree as Tree, type SpecTreeNode } from "@/lib/specs/tree";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export type SpecTreeProps = {
  backlogKey: string;
  backlogId: string;
  nodes: SpecTreeNode[];
  canEdit: boolean;
};

const ROOT_DROP = "drop:root";

/**
 * The specifications' folder tree (Confluence-like): folders open and close,
 * documents open in the main column. Editors create, rename, delete through
 * each row's menu and move by dragging a row onto a folder (inside it), onto
 * a document (right after it) or onto the empty area (at the root).
 */
export function SpecTree({ backlogKey, backlogId, nodes, canEdit }: SpecTreeProps) {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const activeId = params.id ?? null;
  const tree = useMemo(() => buildSpecTree(nodes), [nodes]);
  const [, startTransition] = useTransition();
  const [dialog, setDialog] = useState<SpecNodeDialogRequest | null>(null);
  // Root folders start open, and so does the path to the open document.
  const [open, setOpen] = useState<Set<string>>(() => new Set([
    ...nodes.filter((node) => node.parentId === null && node.kind === "folder").map((node) => node.id),
    ...(activeId ? ancestorsOf(nodes, activeId).map((node) => node.id) : []),
  ]));
  const toggle = (id: string, next?: boolean) =>
    setOpen((current) => {
      const copy = new Set(current);
      if (next ?? !copy.has(id)) copy.add(id); else copy.delete(id);
      return copy;
    });

  const base = `/b/${backlogKey}/specs`;
  const target = { backlogKey, backlogId };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  async function submitDialog(title: string): Promise<string | null> {
    if (!dialog) return null;
    if (dialog.mode === "create") {
      const result = await createSpecNodeAction({ ...target, parentId: dialog.parentId, kind: dialog.kind, title });
      if (!result.ok) return result.error;
      if (dialog.parentId) toggle(dialog.parentId, true);
      setDialog(null);
      if (dialog.kind === "document") router.push(`${base}/${result.id}`);
      return null;
    }
    const result = await renameSpecNodeAction({ ...target, id: dialog.id, title });
    if (!result.ok) return result.error;
    setDialog(null);
    router.refresh();
    return null;
  }

  function trash(node: SpecTreeNode) {
    const inside = descendantIds(nodes, node.id).length - 1;
    if (inside > 0 && !window.confirm(
      `Supprimer « ${node.title} » et ${inside === 1 ? "l’élément qu’il contient" : `les ${inside} éléments qu’il contient`} ?`,
    )) return;
    startTransition(async () => {
      const result = await trashSpecNodeAction({ ...target, id: node.id });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (activeId && result.ids.includes(activeId)) router.push(base);
      toast.success(`« ${node.title} » supprimé.`, {
        action: {
          label: "Annuler",
          run: async () => {
            const restored = await restoreSpecNodeAction({ ...target, id: node.id });
            if (!restored.ok) toast.error(restored.error);
          },
        },
      });
    });
  }

  function onDragEnd(event: DragEndEvent) {
    const draggedId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId) return;
    let parentId: string | null;
    let afterId: string | null;
    if (overId === ROOT_DROP) {
      const roots = tree.filter((node) => node.id !== draggedId);
      parentId = null;
      afterId = roots.at(-1)?.id ?? null;
    } else {
      const over = nodes.find((node) => `drop:${node.id}` === overId);
      if (!over || over.id === draggedId) return;
      if (over.kind === "folder") {
        parentId = over.id;
        const children = nodes
          .filter((node) => node.parentId === over.id && node.id !== draggedId)
          .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
        afterId = children.at(-1)?.id ?? null;
      } else {
        parentId = over.parentId;
        afterId = over.id;
      }
    }
    const refused = checkSpecMove(nodes, draggedId, parentId);
    if (refused) {
      toast.error(refused === "cycle"
        ? "Un dossier ne peut pas être déplacé dans lui-même."
        : "Déplacement impossible.");
      return;
    }
    if (parentId) toggle(parentId, true);
    startTransition(async () => {
      const result = await moveSpecNodeAction({ ...target, id: draggedId, parentId, afterId });
      if (!result.ok) toast.error(result.error);
    });
  }

  const rows = (
    <ul className="flex flex-col gap-px">
      {tree.map((node) => (
        <SpecTreeRow
          key={node.id}
          node={node}
          depth={0}
          base={base}
          activeId={activeId}
          open={open}
          canEdit={canEdit}
          onToggle={toggle}
          onCreate={(kind, parent) => setDialog({ mode: "create", kind, parentId: parent.id, parentTitle: parent.title })}
          onRename={(n) => setDialog({ mode: "rename", id: n.id, kind: n.kind, title: n.title })}
          onTrash={trash}
        />
      ))}
    </ul>
  );

  return (
    <nav aria-label="Arborescence des spécifications" className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-1 px-1">
        <h2 className="t-label flex-1 text-muted-foreground">Arborescence</h2>
        {canEdit ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Nouveau document à la racine"
              title="Nouveau document"
              onClick={() => setDialog({ mode: "create", kind: "document", parentId: null, parentTitle: null })}
            >
              <FilePlus aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Nouveau dossier à la racine"
              title="Nouveau dossier"
              onClick={() => setDialog({ mode: "create", kind: "folder", parentId: null, parentTitle: null })}
            >
              <FolderPlus aria-hidden />
            </Button>
          </>
        ) : null}
      </div>
      {tree.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">
          {canEdit ? "Aucun document. Créez un dossier ou un document." : "Aucun document."}
        </p>
      ) : canEdit ? (
        <DndContext id={`spec-tree-${backlogId}`} sensors={sensors} onDragEnd={onDragEnd}>
          {rows}
          <RootDropZone />
        </DndContext>
      ) : rows}
      <SpecNodeDialog request={dialog} onClose={() => setDialog(null)} onSubmit={submitDialog} />
    </nav>
  );
}

function RootDropZone() {
  const { setNodeRef, isOver } = useDroppable({ id: ROOT_DROP });
  return (
    <div
      ref={setNodeRef}
      aria-hidden
      className={cn(
        "min-h-10 flex-1 rounded-[var(--radius)] border border-dashed border-transparent",
        isOver && "border-[var(--primary)] bg-[var(--muted)]/60",
      )}
    />
  );
}

type RowProps = {
  node: Tree;
  depth: number;
  base: string;
  activeId: string | null;
  open: Set<string>;
  canEdit: boolean;
  onToggle: (id: string) => void;
  onCreate: (kind: "folder" | "document", parent: SpecTreeNode) => void;
  onRename: (node: SpecTreeNode) => void;
  onTrash: (node: SpecTreeNode) => void;
};

function SpecTreeRow(props: RowProps) {
  const { node, depth, base, activeId, open, canEdit, onToggle, onCreate, onRename, onTrash } = props;
  const isFolder = node.kind === "folder";
  const expanded = isFolder && open.has(node.id);
  const active = node.id === activeId;
  const {
    setNodeRef: setDragRef,
    listeners: dragListeners,
    attributes: dragAttributes,
    isDragging,
  } = useDraggable({ id: node.id, disabled: !canEdit });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `drop:${node.id}`, disabled: !canEdit });
  const Icon = isFolder ? (expanded ? FolderOpen : Folder) : FileText;

  return (
    <li>
      <div
        ref={setDropRef}
        className={cn(
          "group flex items-center gap-1 rounded-[var(--radius)] pr-1 text-sm",
          active ? "bg-[var(--accent)] font-semibold text-[var(--primary)]" : "text-foreground hover:bg-[var(--muted)]",
          isOver && !isDragging && "ring-2 ring-[var(--primary)] ring-inset",
          isDragging && "opacity-50",
        )}
        style={{ paddingLeft: `${4 + depth * 16}px` }}
      >
        {isFolder ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            aria-expanded={expanded}
            aria-label={expanded ? `Replier ${node.title}` : `Déplier ${node.title}`}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
          >
            <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
          </button>
        ) : (
          <span aria-hidden className="size-6 shrink-0" />
        )}
        <Link
          ref={setDragRef}
          {...dragListeners}
          {...dragAttributes}
          // dnd-kit's role="button" would hide the link from assistive tech.
          role={undefined}
          href={`${base}/${node.id}`}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 outline-none focus-visible:underline"
        >
          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.title}</span>
        </Link>
        {canEdit ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Actions sur ${node.title}`}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
              >
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isFolder ? (
                <>
                  <DropdownMenuItem onSelect={() => onCreate("document", node)}>
                    <FilePlus aria-hidden /> Nouveau document
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onCreate("folder", node)}>
                    <FolderPlus aria-hidden /> Nouveau dossier
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuItem onSelect={() => onRename(node)}>
                <Pencil aria-hidden /> Renommer
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => onTrash(node)}>
                <Trash2 aria-hidden /> Supprimer
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {expanded && node.children.length > 0 ? (
        <ul className="flex flex-col gap-px">
          {node.children.map((child) => (
            <SpecTreeRow key={child.id} {...props} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
