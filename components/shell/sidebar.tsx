"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  BookText,
  CalendarDays,
  ChartColumn,
  ChartGantt,
  Compass,
  Folder,
  Layers,
  List,
  ListTree,
  Rows3,
  Settings,
  SquareKanban,
  Tag,
  Trash2,
  User,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BacklogSelector } from "@/components/shell/backlog-selector";
import { NavLink } from "@/components/shell/nav-link";
import { useSidebarState } from "@/components/shell/sidebar-state";
import { SidebarSection } from "@/components/shell/sidebar-section";
import { SidebarViews } from "@/components/shell/sidebar-views";
import { useViewUrlState } from "@/components/shell/view-url-state";
import { UserCard } from "@/components/shell/user-card";
import type { SidebarViewRow } from "@/components/shell/sidebar-views";
import {
  activeProjectView,
  deriveShellContext,
  PROJECT_VIEWS,
  projectViewHref,
  type ProjectViewId,
} from "@/lib/items/shell";
import { showAllBacklogItemsParams } from "@/lib/items/views";
import type { ShellCounts } from "@/lib/services/shell";
import type { SpecRootFolder } from "@/lib/services/specs";
import { cn } from "@/lib/utils";

type Backlog = { id: string; key: string; name: string; color: string; starred?: boolean };

const PROJECT_VIEW_ICONS: Record<ProjectViewId, LucideIcon> = {
  "le-point": Compass,
  backlog: Rows3,
  board: SquareKanban,
  list: List,
  tree: ListTree,
  roadmap: ChartGantt,
  releases: Tag,
  reports: ChartColumn,
};

/** A path segment as the router decodes it; a malformed escape stays as written. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function Sidebar({
  backlogs,
  views,
  userId,
  user,
  canAdminister,
  adminHref = "/admin",
  counts,
  specFolders = [],
}: {
  backlogs: Backlog[];
  views: SidebarViewRow[];
  userId: string;
  user: { name: string; email: string; role: string };
  canAdminister: boolean;
  adminHref?: string;
  counts: ShellCounts;
  /** Root folders of the specification trees (Brief, PRD, UX by default). */
  specFolders?: SpecRootFolder[];
}) {
  const { collapsed: desktopCollapsed, mobile } = useSidebarState();
  const collapsed = mobile ? false : desktopCollapsed;
  const viewUrl = useViewUrlState();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const backlogKeys = new Map(backlogs.map((backlog) => [backlog.id, backlog.key]));
  const context = deriveShellContext({
    pathname,
    search: new URLSearchParams(searchParams.toString()),
    backlogs,
    views: views.flatMap((view) => {
      const backlogKey = view.backlogId ? backlogKeys.get(view.backlogId) : undefined;
      return backlogKey ? [{ id: view.id, name: view.name, backlogKey }] : [];
    }),
  });
  const activeKey = context.activeBacklogKey?.toUpperCase();
  const allCount = activeKey ? counts.allByBacklog[activeKey] ?? 0 : 0;
  const onActiveBacklogRoute =
    activeKey !== undefined && pathname.toUpperCase() === `/B/${activeKey}`;
  // The home lists every backlog and only borrows the first one for its views:
  // a backlog is "in use" on its own pages (`/b/KEY` and below), not there.
  const pathBacklogKey = /^\/b\/([^/]+)(?:\/|$)/i.exec(pathname)?.[1];
  const onActiveBacklogPages =
    activeKey !== undefined &&
    pathBacklogKey !== undefined &&
    decodeSegment(pathBacklogKey).toUpperCase() === activeKey;
  const allItemsHref = onActiveBacklogRoute
    ? viewUrl.href(showAllBacklogItemsParams)
    : context.allItemsHref;

  const homeHref = context.activeBacklogKey ? `/b/${context.activeBacklogKey}` : "/";
  const activeBacklog = activeKey
    ? backlogs.find((backlog) => backlog.key.toUpperCase() === activeKey)
    : undefined;
  const activeView = activeBacklog
    ? activeProjectView(pathname, new URLSearchParams(searchParams.toString()), activeBacklog.key)
    : null;
  const specsHref = activeBacklog ? `/b/${encodeURIComponent(activeBacklog.key)}/specs` : null;
  const onSpecs = specsHref !== null
    && (pathname.toUpperCase() === specsHref.toUpperCase() || pathname.toUpperCase().startsWith(`${specsHref.toUpperCase()}/`));
  const activeSpecFolders = activeBacklog
    ? specFolders.filter((folder) => folder.backlogId === activeBacklog.id)
    : [];

  return (
    <div
      className={cn(
        "flex h-full flex-col gap-1 overflow-x-hidden overflow-y-auto border-r border-border bg-[var(--surface-2)]",
        collapsed ? "p-2" : "p-3",
      )}
    >
      <div
        className={cn(
          "flex items-center",
          collapsed ? "h-12 justify-center" : "h-10 px-2",
        )}
      >
        {/* The wordmark leads back to the active backlog home (JIR-72). */}
        <Link
          href={homeHref}
          aria-label="Le Studio — accueil"
          className="rounded-md focus-visible:outline-2 focus-visible:outline-ring"
        >
          <div
            role="img"
            aria-label="Le Studio"
            title={collapsed ? "Le Studio" : undefined}
            className="t-h2 overflow-hidden font-semibold"
          >
            {collapsed ? (
              <span aria-hidden="true">S</span>
            ) : (
              <span aria-hidden="true">
                Le <span className="text-[var(--primary)]">Studio</span>
              </span>
            )}
          </div>
        </Link>
      </div>

      <BacklogSelector
        backlogs={backlogs}
        collapsed={collapsed}
        activeKey={context.activeBacklogKey}
      />

      {/* The BMAD specifications (brief, PRD, UX), above the tickets as in the design. */}
      {specsHref && (
        <SidebarSection id="specs" title="Spécifications" collapsed={collapsed} className="mt-2">
          {activeSpecFolders.length === 0 ? (
            <NavLink
              href={specsHref}
              active={onSpecs}
              ariaLabel={collapsed ? "Spécifications" : undefined}
              collapsed={collapsed}
              title={collapsed ? "Spécifications" : undefined}
            >
              <BookText className="size-4" aria-hidden="true" />
              <span className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate"}>
                Tous les documents
              </span>
            </NavLink>
          ) : (
            activeSpecFolders.map((folder) => (
              <NavLink
                key={folder.id}
                href={`${specsHref}/${folder.id}`}
                active={pathname.endsWith(`/specs/${folder.id}`)}
                ariaLabel={collapsed ? folder.title : undefined}
                collapsed={collapsed}
                title={collapsed ? folder.title : undefined}
              >
                <Folder className="size-4" aria-hidden="true" />
                <span className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate"}>{folder.title}</span>
              </NavLink>
            ))
          )}
        </SidebarSection>
      )}

      <SidebarSection id="tickets" title="Gestion des tickets" collapsed={collapsed} className="mt-2">
        {activeBacklog && (
          <nav aria-label="Vues du projet" className="flex flex-col gap-0.5">
            {PROJECT_VIEWS.map((view) => {
              const Icon = PROJECT_VIEW_ICONS[view.id];
              const itemView = view.kind === "item";
              return (
                <NavLink
                  key={view.id}
                  href={
                    itemView && onActiveBacklogRoute
                      ? viewUrl.href((params) => params.set("view", view.id))
                      : projectViewHref(activeBacklog.key, view.id)
                  }
                  active={activeView === view.id}
                  ariaLabel={collapsed ? view.label : undefined}
                  collapsed={collapsed}
                  title={collapsed ? view.label : undefined}
                  onNavigate={
                    itemView && onActiveBacklogRoute
                      ? (event) => {
                          event.preventDefault();
                          viewUrl.push((latest) => latest.set("view", view.id));
                        }
                      : undefined
                  }
                >
                  <Icon className="size-4" aria-hidden="true" />
                  <span className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate"}>
                    {view.label}
                  </span>
                  {view.id === "le-point" && !collapsed && (
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-muted-foreground">
                      pilote
                    </Badge>
                  )}
                </NavLink>
              );
            })}
          </nav>
        )}

        {/* The team's calendar is a page of its own, not a filter: it sits between the views and the filters.
            From a backlog's pages it opens on that backlog; elsewhere, on every backlog the reader can browse. */}
        <NavLink
          href={onActiveBacklogPages && activeBacklog ? `/presences?backlog=${encodeURIComponent(activeBacklog.key)}` : "/presences"}
          active={context.activeNav === "presences"}
          ariaLabel="Calendrier d’équipe"
          collapsed={collapsed}
          title={collapsed ? "Calendrier d’équipe" : undefined}
        >
          <CalendarDays className="size-4" />
          <span
            className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate"}
          >
            Calendrier d’équipe
          </span>
        </NavLink>

        <div
          className={cn(
            "t-meta px-2 pt-2 pb-1 font-medium uppercase tracking-wide text-muted-foreground",
            collapsed && "sr-only",
          )}
        >
          Filtres
        </div>
        <NavLink
          href={allItemsHref}
          active={context.activeNav === "all"}
          ariaLabel={`Tous les items ${allCount}`}
          collapsed={collapsed}
          title={collapsed ? "Tous les items" : undefined}
          onNavigate={
            onActiveBacklogRoute
              ? (event) => {
                  event.preventDefault();
                  viewUrl.push(showAllBacklogItemsParams, {
                    authoritative: true,
                  });
                }
              : undefined
          }
        >
          <Layers className="size-4" />
          <span
            className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate"}
          >
            Tous les items
          </span>
          <Count value={allCount} collapsed={collapsed} />
        </NavLink>
        <NavLink
          href="/mine"
          active={context.activeNav === "mine"}
          ariaLabel={`Mes items ${counts.mine}`}
          collapsed={collapsed}
          title={collapsed ? "Mes items" : undefined}
        >
          <User className="size-4" />
          <span
            className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate"}
          >
            Mes items
          </span>
          <Count value={counts.mine} collapsed={collapsed} />
        </NavLink>
        {!collapsed && (
          <SidebarViews
            views={views}
            userId={userId}
            backlogs={backlogs}
          />
        )}
      </SidebarSection>

      {/* Steering the team and its agents: the section is announced, its pages come later. */}
      <SidebarSection id="pilotage" title="Pilotage" collapsed={collapsed} className="mt-2 mb-4">
        {!collapsed && <p className="px-2 py-1 text-xs text-muted-foreground">À venir</p>}
      </SidebarSection>

      <div className="mt-auto flex flex-col gap-1">
        <NavLink
          href="/trash"
          active={context.activeNav === "trash"}
          ariaLabel={`Corbeille ${counts.trash}`}
          collapsed={collapsed}
          title={collapsed ? "Corbeille" : undefined}
        >
          <Trash2 className="size-4" />
          <span
            className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate"}
          >
            Corbeille
          </span>
          <Count value={counts.trash} collapsed={collapsed} />
        </NavLink>
        {canAdminister && (
          <NavLink
            href={adminHref}
            active={context.activeNav === "admin"}
            ariaLabel="Administration"
            collapsed={collapsed}
            title={collapsed ? "Administration" : undefined}
          >
            <Settings className="size-4" />
            <span
              className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate"}
            >
              Administration
            </span>
          </NavLink>
        )}
        <UserCard user={user} collapsed={collapsed} />
      </div>
    </div>
  );
}

function Count({ value, collapsed }: { value: number; collapsed: boolean }) {
  return (
    <span
      className={cn(
        "ml-auto text-xs tabular-nums text-muted-foreground",
        collapsed && "sr-only",
      )}
    >
      {value}
    </span>
  );
}
