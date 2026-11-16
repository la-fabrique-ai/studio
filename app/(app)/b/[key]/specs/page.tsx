import { FileText } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export default function SpecsPage() {
  return (
    <div className="flex h-full items-start justify-center rounded-[var(--radius)] border border-dashed border-border px-4 py-16">
      <EmptyState
        icon={<FileText className="size-5" />}
        title="Choisissez un document"
        description="Ouvrez un document dans l’arborescence, ou créez-en un depuis le menu d’un dossier. Brief, PRD et UX suivent la méthode BMAD."
      />
    </div>
  );
}
