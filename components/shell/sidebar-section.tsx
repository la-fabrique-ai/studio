"use client";

import { useId, useLayoutEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const storageKey = (id: string) => `studio-sidebar-section-${id}`;

/**
 * A large sidebar section (Spécifications, Gestion des tickets, Pilotage):
 * an uppercase heading that folds its links away. Each viewer's choice is
 * remembered in this browser. In the icon-only sidebar the heading gives way
 * to a divider and the links always show.
 */
export function SidebarSection({
  id,
  title,
  collapsed,
  className,
  children,
}: {
  /** Stable key of the section, for the remembered state. */
  id: string;
  title: string;
  /** The sidebar is in icon-only mode. */
  collapsed: boolean;
  className?: string;
  children: ReactNode;
}) {
  const contentId = useId();
  const [open, setOpen] = useState(true);

  useLayoutEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(storageKey(id));
    } catch {}
    // Synchronize once with this browser's remembered choice.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored === "closed") setOpen(false);
  }, [id]);

  function toggle() {
    setOpen((current) => {
      const next = !current;
      try {
        localStorage.setItem(storageKey(id), next ? "open" : "closed");
      } catch {}
      return next;
    });
  }

  if (collapsed) {
    return (
      <section aria-label={title} className={cn("flex flex-col gap-0.5", className)}>
        <div aria-hidden="true" className="mx-2 my-1 border-t border-border" />
        {children}
      </section>
    );
  }

  return (
    <section aria-label={title} className={cn("flex flex-col gap-0.5", className)}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={contentId}
        className="t-meta flex items-center gap-1 rounded-md px-2 pt-2 pb-1 text-left font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")}
        />
      </button>
      <div id={contentId} hidden={!open} className="flex flex-col gap-0.5">
        {children}
      </div>
    </section>
  );
}
